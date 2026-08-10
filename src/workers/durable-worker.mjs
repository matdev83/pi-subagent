#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "jiti";

const payloadPath = process.argv[2];
if (!payloadPath) {
	console.error("durable worker missing payload path");
	process.exit(2);
}

const jiti = createJiti(import.meta.url, { interopDefault: false });
const [{ runSubagentTask }, artifacts] = await Promise.all([
	jiti.import("../orchestrate/run.ts"),
	jiti.import("../artifacts/index.ts"),
]);

const payload = JSON.parse(await readFile(payloadPath, "utf8"));
const { input, cwd, runId, attemptId } = payload;
const heartbeatMs = Math.max(
	50,
	Number.parseInt(process.env.PI_SUBAGENT_HEARTBEAT_MS ?? "5000", 10) || 5000,
);
const runRef = { cwd, runId, runsDir: input?.runsDir };
const workerProcessGroupId =
	process.platform === "win32" ? undefined : process.pid;
let terminalWritePromise;
let heartbeat;

// Windows cannot deliver SIGINT/SIGTERM gracefully to this detached,
// console-less process (they arrive as unclean kills, so the handler below
// would never run). Cooperative cancellation: the interrupt path writes an
// interrupt-request.json marker into the attempt directory; this worker polls
// it and self-cancels. The abort controller also tears down the in-flight
// backend process.
const interruptController = new AbortController();
const interruptRequestPath =
	process.platform === "win32"
		? join(
				cwd,
				input?.runsDir ?? ".pi/agent/runs",
				runId,
				"attempts",
				attemptId,
				"interrupt-request.json",
			)
		: undefined;

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeDelayTerminalWriteForTests() {
	const delayMs = Number.parseInt(
		process.env.PI_SUBAGENT_DURABLE_WORKER_TERMINAL_WRITE_DELAY_MS ?? "0",
		10,
	);
	if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
}

async function readExistingAttempt() {
	const record = await artifacts.readRunRecord(runRef).catch(() => null);
	return record?.attempts?.find(
		(candidate) => candidate.attemptId === attemptId,
	);
}

async function writeTerminalResultOnce({
	status,
	failureKind,
	message,
	signal = null,
	exitCode = null,
}) {
	if (heartbeat !== undefined) clearInterval(heartbeat);
	try {
		const existingAttempt = await readExistingAttempt();
		const existingAttemptTerminal = TERMINAL_STATUSES.has(
			existingAttempt?.status,
		);
		const shouldBackfillDuplicateResult =
			existingAttemptTerminal &&
			existingAttempt?.status === status &&
			(existingAttempt.failureKind ?? null) === failureKind;
		if (existingAttemptTerminal && !shouldBackfillDuplicateResult) return;
		await maybeDelayTerminalWriteForTests();
		const store = await artifacts.createAttemptArtifactStore({
			cwd,
			runId,
			attemptId,
			runsDir: input?.runsDir,
		});
		const stderr = await store.writeTextArtifact("stderr", `${message}\n`);
		const worker = store.refFor("worker");
		const result = await store.writeResult({
			backend: payload.backend ?? "headless",
			status,
			failureKind,
			cwd,
			startedAt: payload.startedAt ?? new Date().toISOString(),
			completedAt: new Date().toISOString(),
			workspace: { mode: "shared", cwd },
			sandbox: { enabled: Boolean(input?.sandbox) },
			exitCode,
			signal,
			artifacts: [worker, stderr],
			correlationId: input?.correlationId,
			metadata: { contextLengthExceeded: false },
		});
		if (shouldBackfillDuplicateResult) {
			await artifacts
				.finishAttemptFromResult(runRef, result)
				.catch(() => undefined);
			return;
		}
		const committed = await artifacts
			.commitAttemptResultIfActive(runRef, result)
			.catch(() => ({ committed: false }));
		if (!committed.committed) return;
		const terminalType = status === "cancelled" ? "cancelled" : "failed";
		await artifacts
			.appendRunEvent(runRef, {
				type: `attempt.${terminalType}`,
				attemptId,
				status,
				message,
				data: { failureKind, signal, exitCode },
			})
			.catch(() => undefined);
		await artifacts
			.appendRunEvent(runRef, {
				type: `run.${terminalType}`,
				status,
				message,
				data: { failureKind, signal, exitCode },
			})
			.catch(() => undefined);
	} catch (writeError) {
		console.error(
			writeError instanceof Error
				? (writeError.stack ?? writeError.message)
				: String(writeError),
		);
	}
}

function writeTerminalResult(options) {
	terminalWritePromise ??= writeTerminalResultOnce(options);
	return terminalWritePromise;
}

async function maybeDelayStartForTests() {
	const delayMs = Number.parseInt(
		process.env.PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS ?? "0",
		10,
	);
	if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
}

function requestCancel(signal) {
	void writeTerminalResult({
		status: "cancelled",
		failureKind: "user_cancelled",
		message: `durable worker received ${signal}`,
		signal,
	}).finally(() => {
		process.exitCode = 130;
		process.exit();
	});
}

process.once("SIGINT", () => requestCancel("SIGINT"));
process.once("SIGTERM", () => requestCancel("SIGTERM"));

// Cooperative cancellation poll (Windows): the worker cannot receive POSIX
// signals, so the interrupt path drops an interrupt-request.json marker into
// the attempt directory. Poll it and self-cancel like a signal handler would.
let interruptPoll;
if (interruptRequestPath !== undefined) {
	let handled = false;
	interruptPoll = setInterval(() => {
		if (handled) return;
		void readFile(interruptRequestPath, "utf8")
			.then((raw) => {
				if (handled || raw.length === 0) return;
				handled = true;
				let signal = "SIGINT";
				try {
					const parsed = JSON.parse(raw);
					if (typeof parsed?.signal === "string") signal = parsed.signal;
				} catch {
					// Keep the default signal.
				}
				// Best-effort teardown of the in-flight backend process.
				if (!interruptController.signal.aborted)
					interruptController.abort();
				requestCancel(signal);
			})
			.catch(() => undefined);
	}, 200);
	interruptPoll.unref?.();
}

await artifacts
	.updateAttemptProcess({
		...runRef,
		attemptId,
		process: {
			pid: process.pid,
			processGroupId: workerProcessGroupId,
			command: "pi-subagent durable-worker",
			workerPid: process.pid,
			workerProcessGroupId,
		},
	})
	.catch(() => undefined);
heartbeat = setInterval(() => {
	void artifacts
		.recordAttemptHeartbeat({ ...runRef, attemptId })
		.catch(() => undefined);
}, heartbeatMs);
heartbeat.unref?.();
try {
	await maybeDelayStartForTests();
	await runSubagentTask({
		input: { ...input, async: false, onComplete: undefined },
		cwd,
		runId,
		attemptId,
		signal: interruptController.signal,
	});
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (interruptController.signal.aborted) {
		await writeTerminalResult({
			status: "cancelled",
			failureKind: "user_cancelled",
			message: "durable worker cancelled while the task was aborted",
			signal: "SIGINT",
		});
	} else {
		await writeTerminalResult({
			status: "failed",
			failureKind: "internal",
			message,
			exitCode: null,
		});
	}
	process.exitCode = 1;
} finally {
	if (heartbeat !== undefined) clearInterval(heartbeat);
	if (interruptPoll !== undefined) clearInterval(interruptPoll);
}
