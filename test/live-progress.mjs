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
function writeRunRecord(
	targetRunId,
	targetAttemptId,
	status,
	completedAt = null,
	updatedAt = new Date().toISOString(),
	targetStartedAt = startedAt,
) {
	const targetRunDir = join(runsDir, targetRunId);
	mkdirSync(join(targetRunDir, "attempts", targetAttemptId), { recursive: true });
	writeFileSync(
		join(targetRunDir, "run.json"),
		JSON.stringify({
			schemaVersion: 2,
			runId: targetRunId,
			mode: "single",
			status,
			backend: "herdr",
			startedAt: targetStartedAt,
			updatedAt,
			completedAt,
			latestAttemptId: targetAttemptId,
			attempts: [],
		}),
	);
}
function writeRun(status, completedAt = null, updatedAt = new Date().toISOString()) {
	writeRunRecord(runId, attemptId, status, completedAt, updatedAt);
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

// Explicit binding must continue to work even when the run is older than the
// bounded recency scan and must not confuse it with neighboring runs.
const boundRunId = "run_bound_exact";
const boundAttemptId = "attempt_bound_exact";
const boundAttemptDir = join(runsDir, boundRunId, "attempts", boundAttemptId);
writeRunRecord(
	boundRunId,
	boundAttemptId,
	"running",
	null,
	new Date().toISOString(),
	new Date(Date.now() - 2_000).toISOString(),
);
writeFileSync(
	join(boundAttemptDir, "pi-events.jsonl"),
	JSON.stringify({ type: "message", message: { text: "bound target" } }) + "\n",
);
for (let index = 0; index < 10; index += 1) {
	writeRunRecord(
		`run_newer_${index}`,
		`attempt_newer_${index}`,
		"completed",
		new Date().toISOString(),
		new Date().toISOString(),
	);
}
lp.attachProgress("tool-call-bound", cwd, () => { invalidations += 1; });
lp.bindProgress(
	"tool-call-bound",
	cwd,
	boundRunId,
	boundAttemptId,
	Date.parse(new Date(Date.now() - 2_000).toISOString()),
);
await sleep(1200);
progress = lp.getProgress("tool-call-bound");
check("explicit binding selects the exact run", progress?.runId === boundRunId, progress?.runId);
check("explicit binding reads the exact attempt", progress?.lastLine === "bound target", progress?.lastLine);

writeFileSync(
	join(boundAttemptDir, "pi-events.jsonl"),
	JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "latest assistant delta" },
	}) + "\n",
);
await sleep(1200);
progress = lp.getProgress("tool-call-bound");
check("streaming delta is shown as live text", progress?.lastLine === "latest assistant delta", progress?.lastLine);

const parallelRunIds = ["run_parallel_a", "run_parallel_b"];
const parallelAttemptIds = ["attempt_parallel_a", "attempt_parallel_b"];
for (const [index, parallelRunId] of parallelRunIds.entries()) {
	writeRunRecord(
		parallelRunId,
		parallelAttemptIds[index],
		"running",
		null,
		new Date().toISOString(),
		new Date(Date.now() - 1_000).toISOString(),
	);
}
lp.attachProgress("tool-call-parallel", cwd, () => { invalidations += 1; });
lp.bindProgress("tool-call-parallel", cwd, parallelRunIds[0], parallelAttemptIds[0]);
lp.bindProgress("tool-call-parallel", cwd, parallelRunIds[1], parallelAttemptIds[1]);
await sleep(1200);
progress = lp.getProgress("tool-call-parallel");
check("parallel binding keeps the aggregate running", progress?.status === "running", progress?.status);

// agent_end may be observed before the registry commit. Show finalizing rather
// than continuing to claim the loop is actively running.
writeFileSync(
	join(boundAttemptDir, "pi-events.jsonl"),
	JSON.stringify({ type: "agent_end", messages: [] }) + "\n",
);
await sleep(1200);
progress = lp.getProgress("tool-call-bound");
check("agent_end reports finalizing", progress?.status === "finalizing", progress?.status);

// A terminal result is authoritative even if run.json has not been finalized.
writeFileSync(
	join(boundAttemptDir, "result.json"),
	JSON.stringify({ status: "completed", completedAt: new Date().toISOString() }),
);
await sleep(1200);
progress = lp.getProgress("tool-call-bound");
check("terminal result overrides stale running registry", progress?.status === "completed", progress?.status);

lp.resetProgress();
check("resetProgress clears cache", lp.getProgress("tool-call-1") === undefined);

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — " + failed.length + " FAILED" : ""}`);
process.exit(failed.length ? 1 : 0);
