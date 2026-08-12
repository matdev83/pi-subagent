// Live progress tracking for active subagent tool calls.
//
// The subagent tool's renderCall row ("subagent run · single · worker · …") is
// otherwise static until the run finishes. This module polls the run artifacts
// on disk (`.pi/agent/runs/…`) once per second for every tool call currently
// executing, derives a compact progress snippet (elapsed time, last activity,
// last output line) and pushes a re-render through the ToolRenderContext's
// `invalidate()` callback supplied at attach time.
//
// Matching a tool call to its run is done by recency: runs in the tool's cwd
// that started around the same moment the tool call began, consumed in order.
// That is unambiguous for the typical one-at-a-time case and remains sensible
// when several subagent tool calls run concurrently (each call takes the next
// unmatched run in start order).

import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { clip, stripAnsi } from "./core/text-width.ts";

/** Compact progress snapshot for one active subagent run. */
export interface LiveProgress {
	runId: string;
	attemptId: string | null;
	backend: string;
	status: string;
	startedAt: number;
	completedAt: number | null;
	lastActivityAt: number;
	lastLine: string;
}

interface ProgressEntry {
	toolCallId: string;
	cwd: string;
	startedAt: number;
	invalidate: () => void;
	boundRuns: Array<{ runId: string; attemptId: string | null }>;
	hasExplicitBinding: boolean;
	terminalTicks: number;
	missingSince: number | null;
}

interface ScannedRun {
	dir: string;
	runId: string;
	status: string;
	backend: string;
	startedAt: number;
	completedAt: number | null;
	latestAttemptId: string | null;
}

const entries = new Map<string, ProgressEntry>();
const progressCache = new Map<string, LiveProgress>();
let timer: NodeJS.Timeout | undefined;

const TICK_MS = 1_000;
const RUNS_DIR = ".pi/agent/runs";
const MAX_RUNS_SCANNED = 8;
/** Slack allowed between tool-call start and the run record start. */
const MATCH_WINDOW_MS = 5_000;
/** How long a run start may lag the tool call start (workspace setup etc.). */
const MATCH_MAX_LAG_MS = 90_000;
/** Ticks a terminal run is kept displayed before the tracker detaches. */
const TERMINAL_DETACH_TICKS = 2;
/** Entries that never matched a run are dropped after this long. */
const UNMATCHED_TTL_MS = 10 * 60_000;
/** Bound entries with a vanished run are dropped after this long. */
const MISSING_RUN_TTL_MS = 2 * 60_000;
const TAIL_BYTES = 4_096;
const LAST_LINE_MAX = 40;
const PROGRESS_FILES = ["pi-events.jsonl", "output.log", "stderr.log", "result.json"];
let tickInFlight = false;

/**
 * Start tracking live progress for a tool call. Idempotent per toolCallId.
 * `invalidate` is the ToolRenderContext.invalidate callback for that call.
 */
export function attachProgress(
	toolCallId: string,
	cwd: string,
	invalidate: () => void,
): void {
	const existing = entries.get(toolCallId);
	if (existing !== undefined) {
		existing.invalidate = invalidate;
		if (existing.cwd !== cwd) {
			existing.cwd = cwd;
			existing.boundRuns = [];
			existing.hasExplicitBinding = false;
			existing.startedAt = Date.now();
			existing.terminalTicks = 0;
			progressCache.delete(toolCallId);
		}
		return;
	}
	entries.set(toolCallId, {
		toolCallId,
		cwd,
		startedAt: Date.now(),
		invalidate,
		boundRuns: [],
		hasExplicitBinding: false,
		terminalTicks: 0,
		missingSince: null,
	});
	ensureTimer();
}

/** Bind a tool call to the run record created for that call. */
export function bindProgress(
	toolCallId: string,
	cwd: string,
	runId: string,
	attemptId: string,
	startedAt?: number,
): void {
	const existing = entries.get(toolCallId);
	if (existing === undefined) {
		entries.set(toolCallId, {
			toolCallId,
			cwd,
			startedAt: startedAt ?? Date.now(),
			invalidate: () => undefined,
			boundRuns: [{ runId, attemptId }],
			hasExplicitBinding: true,
			terminalTicks: 0,
			missingSince: null,
		});
	} else {
		existing.cwd = cwd;
		if (!existing.hasExplicitBinding) {
			existing.boundRuns = [];
			existing.hasExplicitBinding = true;
		}
		const existingRun = existing.boundRuns.find((run) => run.runId === runId);
		if (existingRun === undefined)
			existing.boundRuns.push({ runId, attemptId });
		else existingRun.attemptId = attemptId;
		if (startedAt !== undefined)
			existing.startedAt = Math.min(existing.startedAt, startedAt);
		existing.terminalTicks = 0;
		existing.missingSince = null;
	}
	ensureTimer();
}

/** Stop tracking a tool call. The cached snapshot (if any) is kept so the
 * already-rendered row does not flicker; it is dropped when the row is
 * re-rendered by the host after tool completion. */
export function detachProgress(toolCallId: string): void {
	if (entries.delete(toolCallId)) stopTimerIfIdle();
}

/** Latest progress snapshot for a tool call, if one has been derived. */
export function getProgress(toolCallId: string): LiveProgress | undefined {
	return progressCache.get(toolCallId);
}

/** Drop cached snapshots for every tracked call (extension reload/teardown). */
export function resetProgress(): void {
	progressCache.clear();
	for (const toolCallId of [...entries.keys()]) detachProgress(toolCallId);
}

function ensureTimer(): void {
	if (timer !== undefined) return;
	timer = setInterval(() => {
		if (tickInFlight) return;
		tickInFlight = true;
		void tick().finally(() => {
			tickInFlight = false;
		});
	}, TICK_MS);
}

function stopTimerIfIdle(): void {
	if (entries.size !== 0 || timer === undefined) return;
	clearInterval(timer);
	timer = undefined;
	tickInFlight = false;
}

async function tick(): Promise<void> {
	if (entries.size === 0) {
		stopTimerIfIdle();
		return;
	}
	const now = Date.now();
	const byCwd = new Map<string, ProgressEntry[]>();
	for (const entry of entries.values()) {
		const list = byCwd.get(entry.cwd) ?? [];
		list.push(entry);
		byCwd.set(entry.cwd, list);
	}
	for (const [cwd, group] of byCwd) {
		const runs = await scanRuns(cwd);
		const sortedEntries = [...group].sort((a, b) => a.startedAt - b.startedAt);
		const sortedRuns = [...runs]
			.filter((run) => run.startedAt > 0)
			.sort((a, b) => a.startedAt - b.startedAt);
		const used = new Set<number>();
		for (const entry of sortedEntries) {
			if (entry.boundRuns.length > 0) {
				// Explicitly bound calls do not depend on recency or the newest-run cap.
				const matched = (
					await Promise.all(
						entry.boundRuns.map(async (bound) => ({
							bound,
							run: await readRun(cwd, bound.runId),
						})),
					)
				).filter(
					(candidate): candidate is {
						bound: { runId: string; attemptId: string | null };
						run: ScannedRun;
					} => candidate.run !== undefined,
				);
				if (matched.length > 0) {
					entry.missingSince = null;
					await updateBoundEntry(entry, matched, now);
				} else {
					entry.missingSince ??= now;
				}
				continue;
			}
			if (runs.length === 0) continue;
			let matchedIndex = -1;
			for (let index = 0; index < sortedRuns.length; index += 1) {
				if (used.has(index)) continue;
				const run = sortedRuns[index]!;
				const lag = run.startedAt - entry.startedAt;
				if (lag >= -MATCH_WINDOW_MS && lag <= MATCH_MAX_LAG_MS) {
					matchedIndex = index;
					break;
				}
			}
			if (matchedIndex < 0) continue;
			used.add(matchedIndex);
			entry.boundRuns.push({
				runId: sortedRuns[matchedIndex]!.runId,
				attemptId: sortedRuns[matchedIndex]!.latestAttemptId,
			});
			await updateEntry(entry, sortedRuns[matchedIndex]!, now);
		}
	}
	// Detach: terminal runs (kept a couple ticks so "done" is visible), or
	// entries that never matched anything within the TTL.
	for (const [toolCallId, entry] of [...entries]) {
		const matchedTerminal =
			entry.boundRuns.length > 0 &&
			entry.terminalTicks >= TERMINAL_DETACH_TICKS;
		const staleUnmatched =
			entry.boundRuns.length === 0 &&
			now - entry.startedAt > UNMATCHED_TTL_MS;
		const missingBoundRun =
			entry.boundRuns.length > 0 &&
			entry.missingSince !== null &&
			now - entry.missingSince > MISSING_RUN_TTL_MS;
		if (matchedTerminal || staleUnmatched || missingBoundRun)
			detachProgress(toolCallId);
	}
}

async function updateEntry(
	entry: ProgressEntry,
	run: ScannedRun,
	now: number,
): Promise<void> {
	const progress = await buildProgress(entry.cwd, run, now);
	progressCache.set(entry.toolCallId, progress);
	entry.terminalTicks = isTerminal(progress.status)
		? entry.terminalTicks + 1
		: 0;
	try {
		entry.invalidate();
	} catch {
		// Component may already be gone; the tracker's TTL cleans up.
	}
}

async function updateBoundEntry(
	entry: ProgressEntry,
	matched: Array<{
		bound: { runId: string; attemptId: string | null };
		run: ScannedRun;
	}>,
	now: number,
): Promise<void> {
	const progress = aggregateProgress(
		await Promise.all(
			matched.map(({ bound, run }) =>
				buildProgress(entry.cwd, run, now, bound.attemptId),
			),
		),
	);
	progressCache.set(entry.toolCallId, progress);
	entry.terminalTicks = isTerminal(progress.status)
		? entry.terminalTicks + 1
		: 0;
	try {
		entry.invalidate();
	} catch {
		// Component may already be gone; the tracker's TTL cleans up.
	}
}

function isTerminal(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

async function scanRuns(cwd: string): Promise<ScannedRun[]> {
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
	const runs: ScannedRun[] = [];
	for (const dir of dirs.slice(0, MAX_RUNS_SCANNED)) {
		const raw = await readJson(join(runsDir, dir.name, "run.json"));
		if (raw === null || typeof raw !== "object") continue;
		const record = raw as Record<string, unknown>;
		if (typeof record.runId !== "string") continue;
		runs.push(scannedRunFromRecord(record, dir.name));
	}
	return runs;
}

async function readRun(cwd: string, runId: string): Promise<ScannedRun | undefined> {
	const raw = await readJson(join(cwd, RUNS_DIR, runId, "run.json"));
	if (raw === null || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (typeof record.runId !== "string") return undefined;
	return scannedRunFromRecord(record, runId);
}

function scannedRunFromRecord(
	record: Record<string, unknown>,
	dir: string,
): ScannedRun {
	return {
		dir,
		runId: record.runId as string,
		status: typeof record.status === "string" ? record.status : "running",
		backend: typeof record.backend === "string" ? record.backend : "",
		startedAt: Date.parse(
			typeof record.startedAt === "string" ? record.startedAt : "",
		),
		completedAt:
			Date.parse(
				typeof record.completedAt === "string" ? record.completedAt : "",
			) || null,
		latestAttemptId:
			typeof record.latestAttemptId === "string"
				? record.latestAttemptId
				: null,
	};
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

async function buildProgress(
	cwd: string,
	run: ScannedRun,
	now: number,
	attemptIdOverride?: string | null,
): Promise<LiveProgress> {
	let lastActivityAt = run.startedAt;
	let lastLine = "";
	let status = run.status;
	let completedAt = run.completedAt;
	const attemptId = attemptIdOverride ?? run.latestAttemptId;
	if (attemptId !== null) {
		const attemptDir = join(
			cwd,
			RUNS_DIR,
			run.runId,
			"attempts",
			attemptId,
		);
		let newestMtime = run.startedAt;
		for (const name of PROGRESS_FILES) {
			const info = await stat(join(attemptDir, name)).catch(() => null);
			if (info !== null && info.mtimeMs > newestMtime)
				newestMtime = info.mtimeMs;
		}
		const eventsTail = await tailFile(join(attemptDir, "pi-events.jsonl"));
		const outputTail =
			eventsTail.length > 0
				? eventsTail
				: await tailFile(join(attemptDir, "output.log"));
		lastLine = meaningfulLastLine(outputTail);
		lastActivityAt = newestMtime;
		const result = await readJson(join(attemptDir, "result.json"));
		if (result !== null && typeof result === "object") {
			const resultRecord = result as Record<string, unknown>;
			if (
				resultRecord.status === "completed" ||
				resultRecord.status === "failed" ||
				resultRecord.status === "cancelled"
			)
				status = resultRecord.status;
			if (typeof resultRecord.completedAt === "string") {
				const resultCompletedAt = Date.parse(resultRecord.completedAt);
				if (Number.isFinite(resultCompletedAt)) completedAt = resultCompletedAt;
			}
		}
		if (status === "running" && /"type"\s*:\s*"agent_end"/.test(eventsTail))
			status = "finalizing";
	}
	return {
		runId: run.runId,
		attemptId,
		backend: run.backend,
		status,
		startedAt: run.startedAt,
		completedAt,
		lastActivityAt,
		lastLine: clip(sanitizeLine(lastLine), LAST_LINE_MAX),
	};
}

function aggregateProgress(progresses: LiveProgress[]): LiveProgress {
	const first = progresses[0]!;
	const allTerminal = progresses.every((progress) => isTerminal(progress.status));
	const status = progresses.some((progress) => progress.status === "running")
		? "running"
		: progresses.some((progress) => progress.status === "pending")
			? "pending"
			: progresses.some((progress) => progress.status === "finalizing")
				? "finalizing"
				: progresses.some((progress) => progress.status === "failed")
					? "failed"
					: progresses.some((progress) => progress.status === "cancelled")
						? "cancelled"
						: "completed";
	const latest = [...progresses].sort(
		(a, b) => b.lastActivityAt - a.lastActivityAt,
	)[0]!;
	return {
		...first,
		status,
		startedAt: Math.min(...progresses.map((progress) => progress.startedAt)),
		completedAt: allTerminal
			? Math.max(
					...progresses.map(
						(progress) => progress.completedAt ?? progress.startedAt,
					),
				)
			: null,
		lastActivityAt: latest.lastActivityAt,
		lastLine: latest.lastLine,
	};
}

async function tailFile(file: string, maxBytes = TAIL_BYTES): Promise<string> {
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
	const lines = text
		.split(/\r?\n/)
		.map((line) => sanitizeLine(line))
		.filter((line) => line.length > 0);
	if (lines.length === 0) return "";
	const last = lines.at(-1) ?? "";
	if (last.startsWith("{") && last.endsWith("}")) {
		try {
			const event = JSON.parse(last) as Record<string, unknown>;
			const extracted = extractEventText(event);
			if (extracted !== undefined && extracted.length > 0)
				return extracted;
		} catch {
			// Not a parseable JSON event; use the raw line below.
		}
	}
	return last;
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

function sanitizeLine(text: string): string {
	return stripAnsi(text)
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Human readable elapsed time ("9s", "1m23s"). */
export function fmtElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** Compact live progress text for the tool panel row. */
export function formatProgress(progress: LiveProgress): string {
	const elapsed = fmtElapsed(
		(progress.completedAt ?? Date.now()) - progress.startedAt,
	);
	if (progress.status === "completed") return `done in ${elapsed}`;
	if (progress.status === "failed") return `failed after ${elapsed}`;
	if (progress.status === "cancelled") return `cancelled after ${elapsed}`;
	if (progress.status === "finalizing") return `finalizing after ${elapsed}`;
	const last = progress.lastLine.length > 0 ? ` · ${progress.lastLine}` : "";
	return `${elapsed} · live${last}`;
}
