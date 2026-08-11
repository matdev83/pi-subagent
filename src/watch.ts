// Per-subagent progress watcher: command/shortcut access to a modal overlay
// showing live progress for a selected run in the current pi session.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type KeyId,
} from "@earendil-works/pi-tui";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import type { LiveProgress } from "./live-progress.ts";
import { clip, stripAnsi } from "./core/text-width.ts";

const WATCH_REFRESH_MS = 1_000;
const RUNS_DIR = ".pi/agent/runs";
const TAIL_LINES = 24;
const execFileAsync = promisify(execFile);
const TAIL_BYTES = 16_384;
const PROGRESS_FILES = ["pi-events.jsonl", "output.log", "stderr.log", "result.json"];

interface WatchTheme {
	fg?(color: string, text: string): string;
	bold?(text: string): string;
}

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

interface WatchTui {
	requestRender?: () => void;
}

/** Minimal view of a run + live progress for the modal. */
interface TranscriptTool {
	type: "tool";
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: unknown;
	isError: boolean;
	isPartial: boolean;
}

type TranscriptItem =
	| { type: "assistant"; message: AssistantMessage; streaming: boolean }
	| TranscriptTool;

interface WatchRun extends LiveProgress {
	dir: string;
	task: string;
	outputTail: string[];
	transcript: TranscriptItem[];
}

function style(theme: WatchTheme, color: string, text: string): string {
	return theme.fg?.(color, text) ?? text;
}

function bold(theme: WatchTheme, text: string): string {
	return theme.bold?.(text) ?? text;
}

function border(width: number): string {
	return `┌${"─".repeat(Math.max(0, width - 2))}┐`;
}

function borderBottom(width: number): string {
	return `└${"─".repeat(Math.max(0, width - 2))}┘`;
}

function nowMs(): number {
	return Date.now();
}

function fmtAge(ms: number, now = nowMs()): string {
	const delta = Math.max(0, now - ms);
	if (delta < 1_000) return "now";
	if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
	return `${Math.floor(delta / 3_600_000)}h ago`;
}

function fmtDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function sanitize(text: string): string {
	return stripAnsi(text)
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/\r/g, "")
		.trim();
}

/**
 * Register alt+shift+1…9 / ctrl+shift+1…9 shortcuts opening the watcher modal
 * for the Nth most recent subagent run of the current session. Ctrl+number is
 * intentionally avoided: terminals and host interrupt/keybinding layers can
 * encode those chords inconsistently on Windows.
 */
export function registerSubagentWatchShortcuts(pi: ExtensionAPI): void {
	if (typeof pi.registerShortcut !== "function") return;
	pi.registerShortcut("ctrl+shift+u" as KeyId, {
		description: "Open the most recent subagent run",
		handler: (ctx) => void openSubagentWatch(ctx, 0),
	});
	for (let index = 1; index <= 9; index += 1) {
		const digit = String(index) as Digit;
		pi.registerShortcut(`alt+shift+${digit}` as KeyId, {
			description: `Open progress of subagent #${index}`,
			handler: (ctx) => void openSubagentWatch(ctx, index - 1),
		});
		pi.registerShortcut(`ctrl+shift+${digit}` as KeyId, {
			description: `Open progress of subagent #${index} (alternate)`,
			handler: (ctx) => void openSubagentWatch(ctx, index - 1),
		});
	}
}

/**
 * Open the watcher modal for the Nth most recent subagent run (0-based) of the
 * current pi session. Shows live status, elapsed time, last activity and the
 * tail of the run's output. Closes with q/esc.
 */
export async function openSubagentWatch(
	ctx: ExtensionContext,
	index: number,
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify?.(
			"Subagent watch is available only in the interactive TUI.",
			"warning",
		);
		return;
	}
	const cwd = ctx.cwd;
	const sessionId = currentSessionIdFromCtx(ctx);
	let runs = await listSessionRuns(cwd, sessionId);
	if (runs.length === 0 && sessionId !== undefined) {
		// A run can predate session metadata propagation or come from a host
		// compatibility path. Fall back to cwd rather than making the shortcut
		// appear dead.
		runs = await listSessionRuns(cwd, undefined);
	}
	if (runs.length === 0) {
		ctx.ui.notify?.("No subagent runs found in this workspace.", "info");
		return;
	}
	if (index >= runs.length) {
		ctx.ui.notify?.(
			`Only ${runs.length} subagent run${runs.length === 1 ? "" : "s"} in this session (${index + 1} requested).`,
			"info",
		);
		return;
	}
	const target = runs[index]!;
	await ctx.ui.custom<void>(
		(tui: unknown, theme: unknown, _keybindings: unknown, done: () => void) =>
			new SubagentWatch(
				cwd,
				theme as WatchTheme,
				tui as WatchTui & TUI,
				done,
				target,
				index + 1,
			),
		{
			overlay: true,
			overlayOptions: {
				width: "78%",
				maxHeight: "78%",
				anchor: "top-center",
				minWidth: 72,
				margin: { top: 1, left: 2, right: 2 },
			},
		},
	);
}

function currentSessionIdFromCtx(ctx: ExtensionContext): string | undefined {
	const raw = ctx as unknown as {
		sessionManager?: { getSessionId?: () => unknown };
	};
	try {
		const id = raw.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** List runs in the current session (or cwd fallback), newest first. */
export async function listSessionRuns(
	cwd: string,
	sessionId: string | undefined,
): Promise<WatchRun[]> {
	const runsDir = join(cwd, RUNS_DIR);
	const names = await readdir(runsDir, { withFileTypes: true }).catch(
		() => [],
	);
	const dirs: Array<{ name: string; mtime: number }> = [];
	for (const name of names) {
		if (!name.isDirectory()) continue;
		const info = await stat(join(runsDir, name.name)).catch(() => null);
		if (info !== null) dirs.push({ name: name.name, mtime: info.mtimeMs });
	}
	dirs.sort((a, b) => b.mtime - a.mtime);
	const runs: WatchRun[] = [];
	for (const dir of dirs.slice(0, 20)) {
		const raw = await readJson(join(runsDir, dir.name, "run.json"));
		if (raw === null || typeof raw !== "object") continue;
		const record = raw as Record<string, unknown>;
		if (typeof record.runId !== "string") continue;
		if (sessionId !== undefined && record.parentSessionId !== sessionId)
			continue;
		const run = await loadRunProgress(cwd, record, dir.name);
		if (run !== null) runs.push(run);
	}
	return runs;
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

/** Build a WatchRun from a run.json record (reading attempt progress). */
async function loadRunProgress(
	cwd: string,
	record: Record<string, unknown>,
	dir: string,
): Promise<WatchRun | null> {
	const startedAt = Date.parse(
		typeof record.startedAt === "string" ? record.startedAt : "",
	);
	if (!Number.isFinite(startedAt)) return null;
	const latestAttemptId =
		typeof record.latestAttemptId === "string"
			? record.latestAttemptId
			: null;
	const runDir = join(cwd, RUNS_DIR, dir);
	let lastActivityAt = startedAt;
	let lastLine = "";
	let outputTail: string[] = [];
	if (latestAttemptId !== null) {
		const attemptDir = join(runDir, "attempts", latestAttemptId);
		let newestMtime = startedAt;
		for (const name of PROGRESS_FILES) {
			const info = await stat(join(attemptDir, name)).catch(() => null);
			if (info !== null && info.mtimeMs > newestMtime)
				newestMtime = info.mtimeMs;
		}
		const events = await tailFile(join(attemptDir, "pi-events.jsonl"));
		const output =
			events.length > 0
				? events
				: await tailFile(join(attemptDir, "output.log"));
		lastLine = meaningfulLastLine(output);
		outputTail = meaningfulLines(output).slice(-TAIL_LINES);
		lastActivityAt = newestMtime;
	}
	const transcript =
		latestAttemptId === null
			? []
			: await readPiTranscript(
					join(runDir, "attempts", latestAttemptId, "pi-events.jsonl"),
				);
	if (transcript.length === 0) {
		const herdrPaneId = readHerdrPaneId(record, latestAttemptId);
		if (herdrPaneId !== null) {
			const paneOutput = await readHerdrPane(herdrPaneId);
			if (paneOutput.length > 0) {
				outputTail = paneOutput;
				lastLine = paneOutput.at(-1) ?? lastLine;
				lastActivityAt = nowMs();
			}
		}
	}
	const task = await readTask(runDir, latestAttemptId);
	const runId = typeof record.runId === "string" ? record.runId : dir;
	return {
		dir,
		runId,
		attemptId: latestAttemptId,
		backend: typeof record.backend === "string" ? record.backend : "",
		status: typeof record.status === "string" ? record.status : "running",
		startedAt,
		lastActivityAt,
		lastLine: clip(sanitize(lastLine), 90),
		task: clip(sanitize(task), 90),
		outputTail: outputTail.map((line) => clip(sanitize(line), 90)),
		transcript,
		completedAt:
			typeof record.completedAt === "string"
				? Date.parse(record.completedAt)
				: null,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

async function readPiTranscript(file: string): Promise<TranscriptItem[]> {
	const text = await readFile(file, "utf8").catch(() => "");
	if (text.length === 0) return [];
	const items: TranscriptItem[] = [];
	const tools = new Map<string, TranscriptTool>();
	for (const line of text.split(/\r?\n/)) {
		if (line.length === 0) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (
			(event.type === "message_start" || event.type === "message_end") &&
			isRecord(event.message) &&
			event.message.role === "assistant"
		) {
			const existing = items.findLast(
				(item) => item.type === "assistant" && item.streaming,
			);
			if (event.type === "message_end" && existing?.type === "assistant") {
				existing.message = event.message as unknown as AssistantMessage;
				existing.streaming = false;
			} else if (event.type === "message_start") {
				items.push({
					type: "assistant",
					message: event.message as unknown as AssistantMessage,
					streaming: true,
				});
			}
			continue;
		}
		if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
			const update = event.assistantMessageEvent;
			const current = items.findLast(
				(item) => item.type === "assistant" && item.streaming,
			);
			if (current?.type !== "assistant") continue;
			const index = typeof update.contentIndex === "number" ? update.contentIndex : 0;
			const content = current.message.content as unknown as Array<
				Record<string, unknown>
			>;
			if (update.type === "text_delta" && typeof update.delta === "string") {
				const part = content[index];
				if (isRecord(part) && part.type === "text") part.text = `${part.text ?? ""}${update.delta}`;
				else content[index] = { type: "text", text: update.delta };
			}
			if (update.type === "thinking_delta" && typeof update.delta === "string") {
				const part = content[index];
				if (isRecord(part) && part.type === "thinking") part.thinking = `${part.thinking ?? ""}${update.delta}`;
				else content[index] = { type: "thinking", thinking: update.delta };
			}
			continue;
		}
		if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
			const tool: TranscriptTool = {
				type: "tool",
				toolCallId: event.toolCallId,
				toolName: typeof event.toolName === "string" ? event.toolName : "tool",
				args: event.args ?? {},
				isError: false,
				isPartial: true,
			};
			tools.set(tool.toolCallId, tool);
			items.push(tool);
			continue;
		}
		if (
			(event.type === "tool_execution_update" || event.type === "tool_execution_end") &&
			typeof event.toolCallId === "string"
		) {
			const tool = tools.get(event.toolCallId);
			if (tool === undefined) continue;
			tool.result =
				event.type === "tool_execution_update" ? event.partialResult : event.result;
			tool.isPartial = event.type === "tool_execution_update";
			tool.isError = event.type === "tool_execution_end" && event.isError === true;
		}
	}
	return items.slice(-20);
}

function readHerdrPaneId(
	record: Record<string, unknown>,
	attemptId: string | null,
): string | null {
	const attempts = Array.isArray(record.attempts) ? record.attempts : [];
	const attempt = attempts.find(
		(value) =>
			value !== null &&
			typeof value === "object" &&
			(attemptId === null ||
				(value as Record<string, unknown>).attemptId === attemptId),
	);
	if (attempt === undefined || attempt === null || typeof attempt !== "object")
		return null;
	const herdr = (attempt as Record<string, unknown>).herdr;
	if (herdr === null || typeof herdr !== "object") return null;
	const paneId = (herdr as Record<string, unknown>).paneId;
	return typeof paneId === "string" && paneId.length > 0 ? paneId : null;
}

async function readHerdrPane(paneId: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync(
			"herdr",
			[
				"pane",
				"read",
				paneId,
				"--source",
				"recent-unwrapped",
				"--lines",
				String(TAIL_LINES),
				"--format",
				"text",
			],
			{ timeout: 2_000, windowsHide: process.platform === "win32" },
		);
		return stdout
			.split(/\r?\n/)
			.map((line) => sanitize(line))
			.filter((line) => line.length > 0)
			.slice(-TAIL_LINES);
	} catch {
		return [];
	}
}

async function readTask(
	runDir: string,
	attemptId: string | null,
): Promise<string> {
	if (attemptId === null) return "";
	const raw = await readJson(
		join(runDir, "attempts", attemptId, "worker.json"),
	);
	if (raw === null || typeof raw !== "object") return "";
	const input = (raw as Record<string, unknown>).input;
	if (input === null || typeof input !== "object") return "";
	const task = (input as Record<string, unknown>).task;
	return typeof task === "string" ? task : "";
}

async function tailFile(file: string, maxBytes = 8_192): Promise<string> {
	try {
		const info = await stat(file);
		if (info.size <= 0) return "";
		const handle = await open(file, "r");
		try {
			const length = Math.min(maxBytes, info.size);
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(
				buffer,
				0,
				length,
				info.size - length,
			);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close().catch(() => undefined);
		}
	} catch {
		return "";
	}
}

function meaningfulLastLine(text: string): string {
	const lines = meaningfulLines(text);
	return lines.at(-1) ?? "";
}

function meaningfulLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => sanitize(line))
		.filter((line) => line.length > 0)
		.map((line) => extractEventTextFromLine(line));
}

function extractEventTextFromLine(line: string): string {
	if (!line.startsWith("{") || !line.endsWith("}")) return line;
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		const extracted = extractEventText(event);
		if (extracted !== undefined && extracted.length > 0) return extracted;
		// Protocol/control events are useful for artifacts but are not human
		// output. Never dump their raw JSON into the compact watcher UI.
		if (typeof event.type === "string") return "";
	} catch {
		// Keep malformed non-protocol text visible for diagnosis.
	}
	return line;
}

function extractEventText(
	event: Record<string, unknown>,
): string | undefined {
	const message = event.message;
	if (message !== null && typeof message === "object") {
		const m = message as Record<string, unknown>;
		if (typeof m.text === "string" && m.text.length > 0) return m.text;
		if (Array.isArray(m.content)) {
			const parts: string[] = [];
			for (const part of m.content) {
				if (part !== null && typeof part === "object") {
					const text = (part as Record<string, unknown>).text;
					if (typeof text === "string" && text.length > 0)
						parts.push(text);
				}
			}
			if (parts.length > 0) return parts.join(" ");
		}
	}
	if (typeof event.text === "string" && event.text.length > 0)
		return event.text;
	return undefined;
}

/** Live-refreshing modal component showing one subagent run's progress. */
export class SubagentWatch implements Component {
	private run: WatchRun;
	private timer: NodeJS.Timeout | undefined;
	private disposed = false;
	private scrollOffset = 0;
	private followTail = true;
	private viewportHeight = 8;

	constructor(
		private readonly cwd: string,
		private readonly theme: WatchTheme,
		private readonly tui: WatchTui & TUI,
		private readonly done: () => void,
		initial: WatchRun,
		private readonly number: number,
	) {
		this.run = initial;
		// Match pi-btw: request SGR mouse reporting while the focused overlay is open.
		this.tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");
		this.timer = setInterval(() => void this.refresh(), WATCH_REFRESH_MS);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) clearInterval(this.timer);
		this.tui.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
	}

	invalidate(): void {
		// Stateless render; refresh loop owns data invalidation.
	}

	handleInput(data: string): void {
		if (data === "q" || isEscapeKey(data)) {
			this.dispose();
			this.done();
			return;
		}
		const mouseDelta = this.mouseScrollDelta(data);
		if (mouseDelta !== null) {
			this.scroll(mouseDelta);
			return;
		}
		if (isArrowKey(data, "up") || data === "k") {
			this.scroll(-1);
			return;
		}
		if (isArrowKey(data, "down") || data === "j") {
			this.scroll(1);
			return;
		}
		if (data === "pageup" || data === "\u001b[5~") {
			this.scroll(-Math.max(1, this.viewportHeight - 1));
			return;
		}
		if (data === "pagedown" || data === "\u001b[6~") {
			this.scroll(Math.max(1, this.viewportHeight - 1));
			return;
		}
		if (data === "end" || data === "\u001b[F" || data === "\u001b[4~") {
			this.followTail = true;
			this.tui.requestRender?.();
		}
	}

	private async refresh(): Promise<void> {
		if (this.disposed) return;
		const reloaded = await this.reload();
		if (reloaded !== null) this.run = reloaded;
		this.tui.requestRender?.();
	}

	private async reload(): Promise<WatchRun | null> {
		const raw = await readJson(
			join(this.cwd, RUNS_DIR, this.run.dir, "run.json"),
		);
		if (raw === null || typeof raw !== "object") return null;
		return loadRunProgress(this.cwd, raw as Record<string, unknown>, this.run.dir);
	}

	render(width: number): string[] {
		const dialogWidth = Math.max(24, width);
		const innerWidth = Math.max(22, dialogWidth - 2);
		const frameLine = (content: string): string => {
			const truncated = truncateToWidth(content, innerWidth, "");
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return `${style(this.theme, "border", "│")}${truncated}${" ".repeat(padding)}${style(this.theme, "border", "│")}`;
		};
		const borderLine = (edge: "top" | "bottom"): string =>
			style(
				this.theme,
				"border",
				`${edge === "top" ? "┌" : "└"}${"─".repeat(innerWidth)}${edge === "top" ? "┐" : "┘"}`,
			);
		const ruleLine = (): string =>
			style(this.theme, "border", `├${"─".repeat(innerWidth)}┤`);
		const fitLine = (line: string): string =>
			visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
		const run = this.run;
		const lines: string[] = [];
		const statusColor =
			run.status === "completed"
				? "success"
				: run.status === "failed" || run.status === "cancelled"
					? "error"
					: "warning";
		const title = `${bold(this.theme, `subagent #${this.number}`)} ${style(this.theme, "muted", run.backend)}`;
		const status = style(this.theme, statusColor, run.status);
		const elapsed =
			run.completedAt !== null && run.completedAt > 0
				? fmtDuration(run.completedAt - run.startedAt)
				: fmtDuration(nowMs() - run.startedAt);
		lines.push(borderLine("top"));
		lines.push(frameLine(`${title} · ${status} · ${elapsed} · ${run.runId}`));
		const activity = `last activity ${fmtAge(run.lastActivityAt)} · attempt ${run.attemptId ?? "—"} · ${run.backend || "?"} backend`;
		lines.push(frameLine(style(this.theme, "muted", activity)));
		lines.push(ruleLine());
		const taskLines = run.task.length > 0
			? wrapTextWithAnsi(`task: ${run.task}`, innerWidth)
			: [];
		for (const line of taskLines) lines.push(frameLine(style(this.theme, "muted", line)));
		if (taskLines.length > 0) lines.push(ruleLine());
		const transcriptLines = this.renderTranscript(innerWidth);
		const output = this.run.outputTail;
		const terminalLines =
			transcriptLines.length > 0
				? transcriptLines
				: output.length === 0
					? [style(this.theme, "muted", "(no session output available)")]
					: output.flatMap((line) => wrapTextWithAnsi(line, innerWidth));
		const viewportHeight = Math.max(
			6,
			Math.min(22, Math.floor((process.stdout.rows ?? 30) * 0.58)),
		);
		this.viewportHeight = viewportHeight;
		const maxScroll = Math.max(0, terminalLines.length - viewportHeight);
		if (this.followTail) {
			this.scrollOffset = maxScroll;
		} else {
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
			if (this.scrollOffset >= maxScroll) this.followTail = true;
		}
		const visibleOutput = terminalLines.slice(
			this.scrollOffset,
			this.scrollOffset + viewportHeight,
		);
		for (const line of visibleOutput) lines.push(frameLine(line));
		for (let index = visibleOutput.length; index < viewportHeight; index += 1)
			lines.push(frameLine(""));
		lines.push(ruleLine());
		lines.push(
			frameLine(
				style(
					this.theme,
					"dim",
					`↑${this.scrollOffset} ↓${Math.max(0, maxScroll - this.scrollOffset)} · ${this.followTail ? "following tail" : "paused"} · wheel/↑↓/jk · End follow · q/esc close`,
				),
			),
		);
		lines.push(borderLine("bottom"));
		return lines.map(fitLine);
	}

	private scroll(delta: number): void {
		if (delta < 0) this.followTail = false;
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
		this.tui.requestRender?.();
	}

	private mouseScrollDelta(data: string): number | null {
		const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
		if (match === null) return null;
		const button = Number(match[1]);
		if ((button & 64) !== 64) return null;
		return (button & 1) === 0 ? -3 : 3;
	}

	private renderTranscript(width: number): string[] {
		const lines: string[] = [];
		for (const item of this.run.transcript ?? []) {
			if (item.type === "assistant") {
				const component = new AssistantMessageComponent(
					item.message,
					false,
					getMarkdownTheme(),
					"Thinking...",
					0,
				);
				component.updateContent(item.message, item.streaming);
				lines.push(...component.render(width));
				continue;
			}
			const component = new ToolExecutionComponent(
				item.toolName,
				item.toolCallId,
				item.args,
				{ showImages: false },
				undefined,
				this.tui,
				this.cwd,
			);
			component.markExecutionStarted();
			if (item.result !== undefined) {
				const renderedResult =
					isRecord(item.result) && Array.isArray(item.result.content)
						? {
							content: item.result.content as Array<{
								type: string;
								text?: string;
							}>,
							details: item.result.details,
							isError: item.isError,
						}
						: {
							content: [
								{
									type: "text",
									text:
										typeof item.result === "string"
											? item.result
											: JSON.stringify(item.result),
								},
							],
							isError: item.isError,
						};
				component.updateResult(renderedResult, item.isPartial);
			}
			lines.push(...component.render(width));
		}
		return lines;
	}

}

function isEscapeKey(data: string): boolean {
	return (
		data === "\u001b" ||
		data === "escape" ||
		data === "esc" ||
		data === "Esc" ||
		data === "ctrl+[" ||
		data.startsWith("escape") ||
		data.startsWith("esc") ||
		/^\u001b\[27(?:;\d+)?(?::\d+)?u$/.test(data)
	);
}

function isArrowKey(
	data: string,
	direction: "up" | "down" | "left" | "right",
): boolean {
	if (data === direction) return true;
	const legacy: Record<typeof direction, string[]> = {
		up: ["\u001b[A", "\u001bOA", "\u001b[a"],
		down: ["\u001b[B", "\u001bOB", "\u001b[b"],
		left: ["\u001b[D", "\u001bOD", "\u001b[d"],
		right: ["\u001b[C", "\u001bOC", "\u001b[c"],
	};
	if (legacy[direction].includes(data)) return true;
	const suffix: Record<typeof direction, string> = {
		up: "A",
		down: "B",
		right: "C",
		left: "D",
	};
	return new RegExp(`^\\u001b\\[1;\\d+(?::\\d+)?${suffix[direction]}$`).test(
		data,
	);
}
