// Smoke test for the watch modal: listSessionRuns + SubagentWatch render.
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: false });
const watch = await jiti.import("../src/watch.ts");

const results = [];
function check(name, cond, extra = "") {
	results.push({ name, ok: !!cond });
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " -> " + extra : ""}`);
}

const root = mkdtempSync(join(tmpdir(), "pi-watch-test-"));
const cwd = join(root, "repo");
const runsDir = join(cwd, ".pi", "agent", "runs");
const runId = "run_watch_001";
const attemptId = "attempt_watch_001";
const runDir = join(runsDir, runId);
const attemptDir = join(runDir, "attempts", attemptId);
mkdirSync(attemptDir, { recursive: true });

const startedAt = new Date(Date.now() - 90000).toISOString();
writeFileSync(
	join(runDir, "run.json"),
	JSON.stringify({
		schemaVersion: 2, runId, mode: "single", status: "running",
		backend: "herdr", parentSessionId: "session-abc", startedAt,
		updatedAt: new Date().toISOString(), completedAt: null,
		latestAttemptId: attemptId, attempts: [],
	}),
);
writeFileSync(
	join(attemptDir, "worker.json"),
	JSON.stringify({ runId, attemptId, input: { agent: "worker", task: "Run the tests" }, cwd }),
);
writeFileSync(
	join(attemptDir, "output.log"),
	"line one\nline two\nAll tests passed.\n",
);

// listSessionRuns scoped to the session.
const all = await watch.listSessionRuns(cwd, undefined);
check("listSessionRuns finds fabricated run", all.length === 1 && all[0].runId === runId, JSON.stringify(all.map(r => r.runId)));
check("task extracted from worker.json", all[0]?.task === "Run the tests", all[0]?.task);
check("lastLine from output.log", all[0]?.lastLine === "All tests passed.", all[0]?.lastLine);
check("status running", all[0]?.status === "running");

const scoped = await watch.listSessionRuns(cwd, "session-abc");
check("session scope includes matching session", scoped.length === 1);
const other = await watch.listSessionRuns(cwd, "session-other");
check("session scope excludes other session", other.length === 0);

// Render the modal component.
let closed = false;
const theme = {
	fg: (color, text) => `[${color}]${text}[/${color}]`,
	bold: (text) => `*${text}*`,
};
const tui = { requestRender: () => {} };
const modal = new watch.SubagentWatch(cwd, theme, tui, () => { closed = true; }, all[0], 1);
const lines = modal.render(80);
const joined = lines.join("\n");
check("render produces lines", lines.length >= 6, `lines=${lines.length}`);
check("title shows subagent #1", joined.includes("subagent #1"), lines[1]);
check(
	"content has one-character horizontal padding",
		lines[1].startsWith("[border]│[/border] "),
		lines[1],
	);
check("status shown", joined.includes("running"));
check(
	"run identity or status shown in narrow render",
	joined.includes("run_w") || joined.includes("running"),
	lines[1],
);
check("output tail shown", joined.includes("All tests passed."));
check("footer shows close hint", joined.includes("q/esc"));

modal.handleInput("q");
check("q closes modal", closed === true);

// Cleanup the interval by disposing.
modal.dispose();
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`);
process.exit(results.some(r => !r.ok) ? 1 : 0);
