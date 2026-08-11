// Per-subagent progress watcher: keyboard shortcuts (ctrl+1…9, ctrl+alt+1…9)
// that open a modal overlay showing the live session progress of the Nth most
// recent subagent run in the current pi session.

import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Component, KeyId } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveProgress } from "./live-progress.ts";
import { clip, stripAnsi } from "./core/text-width.ts";

const WATCH_REFRESH_MS = 1_000;
const RUNS_DIR = ".pi/agent/runs";
const TAIL_LINES = 10;
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
interface WatchRun extends LiveProgress {
	dir: string;
	task: string;
	outputTail: string[];
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
				tui as WatchTui,
				done,
				target,
				index + 1,
			),
		{
			overlay: true,
			overlayOptions: {
				width: "62%",
				maxHeight: "55%",
				anchor: "center",
				minWidth: 60,
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
		completedAt:
			typeof record.completedAt === "string"
				? Date.parse(record.completedAt)
				: null,
	};
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

	constructor(
		private readonly cwd: string,
		private readonly theme: WatchTheme,
		private readonly tui: WatchTui,
		private readonly done: () => void,
		initial: WatchRun,
		private readonly number: number,
	) {
		this.run = initial;
		this.timer = setInterval(() => void this.refresh(), WATCH_REFRESH_MS);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) clearInterval(this.timer);
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
		if (isArrowKey(data, "up") || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender?.();
			return;
		}
		if (isArrowKey(data, "down") || data === "j") {
			this.scrollOffset += 1;
			this.tui.requestRender?.();
			return;
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
		const safeWidth = Math.max(20, width);
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
		lines.push(style(this.theme, "border", border(safeWidth)));
		lines.push(
			clip(
				`${title} · ${status} · ${elapsed} · ${run.runId}`,
				safeWidth,
			),
		);
		lines.push(style(this.theme, "border", border(safeWidth)));
		const task = run.task.length > 0 ? `task: ${run.task}` : "";
		if (task.length > 0) lines.push(clip(style(this.theme, "muted", task), safeWidth));
		const activity = `last activity ${fmtAge(run.lastActivityAt)} · attempt ${run.attemptId ?? "—"} · ${run.backend || "?"} backend`;
		lines.push(clip(style(this.theme, "muted", activity), safeWidth));
		lines.push(style(this.theme, "border", border(safeWidth)));
		lines.push(style(this.theme, "muted", "─ last output ─"));
		const output = this.run.outputTail;
		if (output.length === 0) {
			lines.push(style(this.theme, "muted", "(no output yet)"));
		} else {
			for (const line of output.slice(this.scrollOffset, this.scrollOffset + 10)) {
				lines.push(clip(line, safeWidth));
			}
		}
		lines.push(style(this.theme, "border", borderBottom(safeWidth)));
		lines.push(style(this.theme, "dim", "↑↓/jk scroll · q/esc close"));
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
