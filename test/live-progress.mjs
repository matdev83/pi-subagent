// Harness test for the live-progress tracker: fabricates run dirs, attaches a
// fake tool call, waits for ticks, and asserts the derived progress snapshot.
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: false });
const lp = await jiti.import("../src/live-progress.ts");

const results = [];
function check(name, cond, extra = "") {
	results.push({ name, ok: !!cond, extra });
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " -> " + extra : ""}`);
}

const root = mkdtempSync(join(tmpdir(), "pi-lp-test-"));
const cwd = join(root, "repo");
const runsDir = join(cwd, ".pi", "agent", "runs");
const runId = "run_harness_001";
const attemptId = "attempt_harness_001";
const runDir = join(runsDir, runId);
const attemptDir = join(runDir, "attempts", attemptId);
mkdirSync(attemptDir, { recursive: true });

const startedAt = new Date(Date.now() - 3000).toISOString();
function writeRun(status, completedAt = null, updatedAt = new Date().toISOString()) {
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({
			schemaVersion: 2,
			runId,
			mode: "single",
			status,
			backend: "herdr",
			startedAt,
			updatedAt,
			completedAt,
			latestAttemptId: attemptId,
			attempts: [],
		}),
	);
}
writeRun("running");
writeFileSync(
	join(attemptDir, "pi-events.jsonl"),
	JSON.stringify({ type: "message", message: { text: "compiling package one" } }) + "\n" +
	JSON.stringify({ type: "message", message: { text: "ok (1.234s)" } }) + "\n",
);

let invalidations = 0;
lp.attachProgress("tool-call-1", cwd, () => { invalidations += 1; });

// Wait enough ticks for the tracker to scan + populate.
await sleep(3200);
let progress = lp.getProgress("tool-call-1");
check("running run matched by recency", progress?.runId === runId, JSON.stringify(progress?.runId));
check("status running", progress?.status === "running");
check("lastLine parsed from event text", progress?.lastLine === "ok (1.234s)", progress?.lastLine);
check("lastActivityAt updated", (progress?.lastActivityAt ?? 0) > Date.now() - 60000);
check("invalidate called at least once", invalidations >= 1, String(invalidations));

// Transition the run to completed and verify the snapshot freezes elapsed.
const completedAt = new Date(Date.now()).toISOString();
writeRun("completed", completedAt, new Date().toISOString());
await sleep(3200);
progress = lp.getProgress("tool-call-1");
check("completed status observed", progress?.status === "completed", progress?.status);
check("completedAt recorded", progress?.completedAt !== null);
const completedLabel = lp.formatProgress(progress);
check("completed label starts with 'done in'", completedLabel.startsWith("done in"), completedLabel);
const completedElapsed = completedLabel;

// Cache is kept after auto-detach (row should not flicker).
await sleep(2200);
const after = lp.getProgress("tool-call-1");
check("cache retained after terminal detach", after?.status === "completed");

// formatProgress for a synthetic running run shows elapsed + live + line.
const runningLabel = lp.formatProgress({
	runId: "x", attemptId: null, backend: "herdr", status: "running",
	startedAt: Date.now() - 5000, completedAt: null, lastActivityAt: Date.now(),
	lastLine: "running the tests",
});
check("running label includes live + line", runningLabel.includes("live") && runningLabel.includes("running the tests"), runningLabel);

lp.resetProgress();
check("resetProgress clears cache", lp.getProgress("tool-call-1") === undefined);

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — " + failed.length + " FAILED" : ""}`);
process.exit(failed.length ? 1 : 0);
