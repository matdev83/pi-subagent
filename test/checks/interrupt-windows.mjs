// Windows-specific test: cooperative cancel of the durable worker via the
// interrupt-request.json marker. The worker polls the marker and self-cancels
// (writes cancelled/user_cancelled, exits 130) because POSIX signals cannot
// reach a detached console-less process on Windows.
// Skipped (exit 0) on non-Windows platforms.
import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

if (process.platform !== "win32") {
	console.log("skipped (non-Windows)");
	process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "pi-interrupt-win-"));
const cwd = join(root, "repo");
const runsDir = ".pi/agent/runs";
const runId = "run_interrupt_win_001";
const attemptId = "attempt_interrupt_win_001";
const attemptDir = join(cwd, runsDir, runId, "attempts", attemptId);
mkdirSync(attemptDir, { recursive: true });

const workerPath = join(import.meta.dirname, "../../src/workers/durable-worker.mjs");
const payloadPath = join(attemptDir, "worker.json");
writeFileSync(
	payloadPath,
	JSON.stringify({
		input: {
			backend: "headless",
			agent: "worker",
			task: "delayed noop (interrupted before start)",
			runsDir,
			async: false,
			onComplete: undefined,
		},
		cwd,
		runId,
		attemptId,
		startedAt: new Date().toISOString(),
		backend: "headless",
	}),
);

const results = [];
function check(name, cond, extra = "") {
	results.push({ name, ok: !!cond });
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " -> " + extra : ""}`);
}

const worker = spawn(process.execPath, [workerPath, payloadPath], {
	cwd,
	detached: true,
	stdio: "ignore",
	env: {
		...process.env,
		PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS: "15000",
	},
});
worker.unref?.();

await sleep(1500); // worker boots and starts the marker poll

const markerPath = join(attemptDir, "interrupt-request.json");
writeFileSync(
	markerPath,
	JSON.stringify({ signal: "SIGINT", reason: "windows interrupt test", requestedAt: new Date().toISOString() }),
);

const deadline = Date.now() + 10_000;
let result = null;
while (Date.now() < deadline) {
	await sleep(300);
	const resultPath = join(attemptDir, "result.json");
	if (existsSync(resultPath)) {
		try {
			result = JSON.parse(readFileSync(resultPath, "utf8"));
			break;
		} catch {
			/* partial write */
		}
	}
}

check(
	"cancelled result written within 10s",
	result?.status === "cancelled",
	JSON.stringify(result && { status: result.status, failureKind: result.failureKind }),
);
check(
	"failureKind user_cancelled",
	result?.failureKind === "user_cancelled",
	result?.failureKind,
);
check(
	"signal recorded as SIGINT",
	result?.signal === "SIGINT",
	result?.signal,
);
check("worker exited (no longer alive)", (() => {
	try {
		process.kill(worker.pid, 0);
		return false;
	} catch {
		return true;
	}
})());

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
