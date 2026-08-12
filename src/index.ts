import { resolve } from "node:path";
import { Type } from "typebox";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	applyAgentRuntimeDefaults,
	loadAgentByName,
	type AgentDefinition,
} from "./agents.ts";
import {
	catalogEntries,
	discoverSubagentCatalog,
	formatAgentCatalogText,
} from "./catalog.ts";
import {
	appendRunEvent,
	createAttemptArtifactStore,
	setRunDependency,
	type ArtifactRef,
	type ResultEnvelope,
} from "./artifacts/index.ts";
import {
	AGENT_SCOPES,
	ASYNC_DEPENDENCIES,
	BACKENDS,
	EXECUTION_MODES,
	ON_COMPLETE_ACTIONS,
	THINKING_LEVELS,
	WORKSPACE_MODES,
	WORKTREE_POLICIES,
	type ExecutionMode,
	type ResolveInput,
	type ResolveValidationFailure,
	type ResolvedBackend,
} from "./core/constants.ts";
import { resolveBackend } from "./core/resolver.ts";
import { clip, visibleLength } from "./core/text-width.ts";
import { validateResolveInput } from "./core/validation.ts";
import {
	startAsyncParallelSubagentRuns,
	startAsyncSubagentRun,
} from "./orchestrate/async.ts";
import { interruptRun } from "./orchestrate/interrupt.ts";
import { reconcileSubagentRun } from "./orchestrate/reconcile.ts";
import { resolveRunRef, listRunLocators } from "./orchestrate/run-ref.ts";
import {
	DEFAULT_PARALLEL_CONCURRENCY,
	runParallelSubagentTasks,
	runSubagentTask,
} from "./orchestrate/run.ts";
import { getRunLogs, getRunStatus, waitForRun } from "./orchestrate/status.ts";
import { showSubagentPanel } from "./panel.ts";
import {
	attachProgress,
	formatProgress,
	getProgress,
	resetProgress,
	type LiveProgress,
} from "./live-progress.ts";
import {
	listSessionRuns,
	openSubagentWatch,
	registerSubagentWatchShortcuts,
} from "./watch.ts";
import { WorkspacePolicyError } from "./workspace/worktree.ts";

const TOOL_NAME = "subagent";
const SUPPORTED_KEYS = new Set([
	"backend",
	"visible",
	"sandbox",
	"agent",
	"task",
	"roleContext",
	"agentScope",
	"confirmProjectAgents",
	"mode",
	"tasks",
	"concurrency",
	"failFast",
	"cancelSiblingsOnFailure",
	"asyncDependency",
	"workspace",
	"worktree",
	"worktreePolicy",
	"cwd",
	"async",
	"onComplete",
	"model",
	"tools",
	"systemPrompt",
	"skills",
	"extensions",
	"runsDir",
	"correlationId",
	"captureToolCalls",
	"thinking",
	"thinkingLevel",
	"reasoningLevel",
	"action",
	"runId",
	"attemptId",
	"taskId",
	"pollIntervalMs",
	"reason",
	"signal",
	"scope",
	"limit",
]);
const AGENT_TASK_KEYS = [
	"agent",
	"task",
	"roleContext",
	"agentScope",
	"confirmProjectAgents",
];
const SANDBOX_SCHEMA = Type.Union(
	[
		Type.Boolean(),
		Type.Null(),
		Type.Object({
			allowedDomains: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						'Network domains the sandboxed child may reach, e.g. "api.anthropic.com" or "*.npmjs.org". Model-backed sandboxed runs must include their provider endpoint. Omitted means deny-all network.',
				}),
			),
		}),
	],
	{
		description:
			"true = offline OS sandbox; { allowedDomains: [...] } = sandbox with explicit network egress; false/null = no sandbox.",
	},
);
const SUBAGENT_TASK_SCHEMA = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1 })),
	task: Type.Optional(Type.String({ minLength: 1 })),
	roleContext: Type.Optional(Type.String({ minLength: 1 })),
	agentScope: Type.Optional(
		Type.Union(AGENT_SCOPES.map((value) => Type.Literal(value))),
	),
	confirmProjectAgents: Type.Optional(Type.Boolean()),
	sandbox: Type.Optional(SANDBOX_SCHEMA),
	visible: Type.Optional(Type.Boolean()),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	model: Type.Optional(Type.String({ minLength: 1 })),
	thinking: Type.Optional(
		Type.Union(THINKING_LEVELS.map((value) => Type.Literal(value))),
	),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	systemPrompt: Type.Optional(Type.String({ minLength: 1 })),
	skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	captureToolCalls: Type.Optional(
		Type.Boolean({
			description:
				"Capture redacted child tool-call telemetry as artifacts. Default false.",
		}),
	),
});

interface ToolTextContent {
	type: "text";
	text: string;
}

interface ToolResult {
	content: ToolTextContent[];
	details: unknown;
	isError: boolean;
}

class SingleLineComponent {
	constructor(private readonly text: string) {}

	invalidate(): void {
		// Static one-line component.
	}

	render(width: number): string[] {
		return [clip(this.text, width)];
	}
}

class HiddenComponent {
	invalidate(): void {
		// Intentionally invisible.
	}

	render(_width: number): string[] {
		return [];
	}
}

/**
 * Tool-panel row for the subagent tool. Shows the static call summary plus a
 * live progress suffix (elapsed time, last activity, last output line) that
 * updates while the run is in flight via the progress tracker.
 */
class ProgressLineComponent {
	constructor(
		private readonly base: string,
		private readonly getProgress: () => LiveProgress | undefined,
	) {}

	invalidate(): void {
		// Progress is pulled on every render from the live-progress tracker.
	}

	render(width: number): string[] {
		const progress = this.getProgress();
		if (progress === undefined) return [clip(this.base, width)];
		const suffix = formatProgress(progress);
		const separator = " · ";
		const baseWidth = Math.max(
			4,
			width - visibleLength(suffix) - visibleLength(separator),
		);
		return [clip(`${clip(this.base, baseWidth)}${separator}${suffix}`, width)];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAnyKey(
	input: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return keys.some((key) => Object.hasOwn(input, key));
}

function formatKeyList(keys: readonly string[]): string {
	return keys.map((key) => `"${key}"`).join(", ");
}

function getExecuteParams(first: unknown, second: unknown): unknown {
	return second === undefined ? first : second;
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
	return isRecord(value) && typeof value.aborted === "boolean";
}

function normalizeExecuteArgs(args: unknown[]): {
	params: unknown;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateCallback;
	ctx?: unknown;
} {
	const [first, second, third, fourth, fifth] = args;
	const params = getExecuteParams(first, second);

	// Pi has shipped both execute(toolCallId, params, signal, onUpdate, ctx)
	// and execute(toolCallId, params, onUpdate, ctx, signal) call orders. Support
	// both so context-scoped metadata (cwd/session) and cancellation survive either
	// host version.
	if (typeof third === "function") {
		return {
			params,
			onUpdate: third as ToolUpdateCallback,
			ctx: fourth,
			...(isAbortSignalLike(fifth) ? { signal: fifth } : {}),
		};
	}

	if (isAbortSignalLike(fifth) && !isAbortSignalLike(third)) {
		return {
			params,
			signal: fifth,
			...(typeof fourth === "function"
				? { onUpdate: fourth as ToolUpdateCallback }
				: { ctx: fourth }),
		};
	}

	return {
		params,
		...(isAbortSignalLike(third) ? { signal: third } : {}),
		...(typeof fourth === "function"
			? { onUpdate: fourth as ToolUpdateCallback }
			: {}),
		ctx: fifth,
	};
}

function getCwd(ctx: unknown): string {
	if (isRecord(ctx) && typeof ctx.cwd === "string" && ctx.cwd.length > 0)
		return ctx.cwd;
	return process.cwd();
}

function parentSessionIdFromCtx(ctx: unknown): string | undefined {
	if (!isRecord(ctx)) return undefined;
	const sessionManager = ctx.sessionManager;
	if (
		!isRecord(sessionManager) ||
		typeof sessionManager.getSessionId !== "function"
	)
		return undefined;
	try {
		const id = (sessionManager.getSessionId as () => unknown)();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function textResult(
	payload: unknown,
	isError: boolean,
	details?: unknown,
): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		details,
		isError,
	};
}

function resultSummary(payload: unknown): string {
	if (!isRecord(payload)) return "Done";
	const status = displayText(payload.status, 20) ?? "completed";
	const runId = displayText(payload.runId, 32);
	const backend = displayText(payload.backend, 16);
	const failureKind = displayText(payload.failureKind, 24);
	if (status === "running")
		return ["Started", backend, runId].filter(Boolean).join(" · ");
	if (status === "completed")
		return ["Completed", backend, runId].filter(Boolean).join(" · ");
	if (status === "cancelled")
		return ["Cancelled", failureKind, runId].filter(Boolean).join(" · ");
	if (status === "failed")
		return ["Failed", failureKind, runId].filter(Boolean).join(" · ");
	return [status, runId].filter(Boolean).join(" · ");
}

function artifactSummary(artifacts: readonly ArtifactRef[]) {
	return artifacts.map((artifact) => ({
		type: artifact.type,
		path: artifact.path,
		...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes }),
	}));
}

function compactResult(result: ResultEnvelope, error?: string) {
	return {
		tool: TOOL_NAME,
		backend: result.backend,
		status: result.status,
		failureKind: result.failureKind,
		...(error === undefined ? {} : { error }),
		runId: result.runId,
		attemptId: result.attemptId,
		...(result.taskId === undefined ? {} : { taskId: result.taskId }),
		...(result.correlationId === undefined
			? {}
			: { correlationId: result.correlationId }),
		durationMs: result.durationMs,
		exitCode: result.exitCode,
		signal: result.signal,
		sandbox: result.sandbox,
		workspace: result.workspace,
		...(result.tmux === undefined ? {} : { tmux: result.tmux }),
		...(result.herdr === undefined ? {} : { herdr: result.herdr }),
		...(result.completion === undefined
			? {}
			: { completion: result.completion }),
		metadata: result.metadata,
		artifacts: artifactSummary(result.artifacts),
	};
}

function displayText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length <= maxLength
		? normalized
		: `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function subagentCallSummary(input: unknown): string {
	const args = isRecord(input) ? input : {};
	const action = displayText(args.action, 16) ?? "run";
	const mode =
		displayText(args.mode, 16) ??
		(Array.isArray(args.tasks) ? "parallel" : "single");
	const pieces = [`subagent ${action}`];

	if (action === "run") {
		pieces.push(mode);
		if (Array.isArray(args.tasks))
			pieces.push(
				`${args.tasks.length} run${args.tasks.length === 1 ? "" : "s"}`,
			);
		const agent = displayText(args.agent, 24);
		if (agent) pieces.push(agent);
		const task = displayText(args.task, 48);
		if (task) pieces.push(task);
		const asyncMode =
			args.async === true ? "async" : displayText(args.onComplete, 16);
		if (args.failFast === true || args.cancelSiblingsOnFailure === true)
			pieces.push("fail-fast");
		if (asyncMode) pieces.push(asyncMode);
	} else {
		const runId = displayText(args.runId, 28);
		if (runId) pieces.push(runId);
		const attemptId =
			displayText(args.attemptId, 16) ?? displayText(args.taskId, 16);
		if (attemptId) pieces.push(attemptId);
	}

	return pieces.filter(Boolean).join(" · ");
}

function isRunAction(input: unknown): boolean {
	const args = isRecord(input) ? input : {};
	return args.action === undefined || args.action === "run";
}

function isLogsAction(input: unknown): boolean {
	return isRecord(input) && input.action === "logs";
}

function validationFailure(failure: ResolveValidationFailure): ToolResult {
	return textResult(
		{
			tool: TOOL_NAME,
			backend: failure.backend,
			status: failure.status,
			failureKind: failure.failureKind,
			error: failure.error,
		},
		true,
		{ resolved: failure },
	);
}

class InputValidationError extends Error {
	readonly failureKind = "validation" as const;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0)
		throw new InputValidationError(
			`${fieldName} must be a non-empty string when provided.`,
		);
	return value;
}

function optionalPositiveNumber(
	value: unknown,
	fieldName: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		throw new InputValidationError(
			`${fieldName} must be a positive finite number when provided.`,
		);
	return value;
}

async function lifecycleAction(
	raw: Record<string, unknown>,
	cwd: string,
	parentSessionId?: string,
): Promise<ToolResult | null> {
	const action = raw.action ?? "run";
	if (action === "run") return null;
	if (action === "runs") {
		const scope =
			optionalString(raw.scope, "scope") ??
			(raw.scope === undefined ? "session" : undefined);
		if (scope === undefined || !["session", "cwd", "all"].includes(scope)) {
			throw new InputValidationError(
				'scope must be one of "session", "cwd", or "all" when provided.',
			);
		}
		const limit = Math.min(
			50,
			Math.max(1, Math.floor(optionalPositiveNumber(raw.limit, "limit") ?? 10)),
		);
		let runs: Array<Record<string, unknown>>;
		if (scope === "all") {
			const { locators } = await listRunLocators();
			runs = locators
				.slice()
				.sort(
					(left, right) =>
						Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
				)
				.slice(0, limit)
				.map((locator) => ({
					runId: locator.runId,
					cwd: locator.cwd,
					...(locator.runsDir === undefined ? {} : { runsDir: locator.runsDir }),
					...(locator.parentSessionId === undefined
						? {}
						: { parentSessionId: locator.parentSessionId }),
					...(locator.correlationId === undefined
						? {}
						: { correlationId: locator.correlationId }),
					updatedAt: locator.updatedAt,
				}));
		} else {
			const scoped = await listSessionRuns(
				cwd,
				scope === "session" ? parentSessionId : undefined,
			);
			runs = scoped.slice(0, limit).map((run) => ({
				runId: run.runId,
				attemptId: run.attemptId,
				status: run.status,
				backend: run.backend,
				startedAt: new Date(run.startedAt).toISOString(),
				completedAt:
					run.completedAt === null || run.completedAt <= 0
						? null
						: new Date(run.completedAt).toISOString(),
				task: run.task,
				lastLine: run.lastLine,
			}));
		}
		return textResult(
			{
				tool: TOOL_NAME,
				action: "runs",
				scope,
				cwd,
				parentSessionId,
				count: runs.length,
				runs,
			},
			false,
			{ runs, scope, parentSessionId },
		);
	}
	if (action === "agents") {
		const catalogCwd = optionalString(raw.cwd, "cwd") ?? cwd;
		const { agents, projectAgentsDir } =
			await discoverSubagentCatalog(catalogCwd);
		const entries = catalogEntries(agents);
		return textResult(
			{
				tool: TOOL_NAME,
				action: "agents",
				projectAgentsDir,
				cwd: catalogCwd,
				agents: entries,
			},
			false,
			{ agents: entries, projectAgentsDir, cwd: catalogCwd },
		);
	}
	if (
		action !== "status" &&
		action !== "logs" &&
		action !== "wait" &&
		action !== "interrupt" &&
		action !== "mark-background" &&
		action !== "reconcile"
	) {
		throw new InputValidationError(
			'action must be one of "run", "agents", "runs", "status", "logs", "wait", "interrupt", "mark-background", or "reconcile" when provided.',
		);
	}

	const runId = optionalString(raw.runId, "runId");
	if (runId === undefined)
		throw new InputValidationError(
			`${String(action)} action requires a non-empty runId.`,
		);
	const ref = await resolveRunRef(
		{
			cwd: optionalString(raw.cwd, "cwd"),
			runId,
			attemptId:
				optionalString(raw.attemptId, "attemptId") ??
				optionalString(raw.taskId, "taskId"),
			runsDir: optionalString(raw.runsDir, "runsDir"),
		},
		cwd,
	);

	if (action === "status") {
		const snapshot = await getRunStatus(ref);
		return textResult(
			{
				tool: TOOL_NAME,
				action,
				status: snapshot === null ? "failed" : snapshot.status,
				snapshot,
			},
			snapshot === null,
			{ snapshot },
		);
	}

	if (action === "logs") {
		const snapshot = await getRunLogs(ref);
		return textResult(
			{
				tool: TOOL_NAME,
				action,
				status: snapshot === null ? "failed" : snapshot.status,
				snapshot,
			},
			snapshot === null,
			{ snapshot },
		);
	}

	if (action === "mark-background") {
		const record = await setRunDependency(ref, "background");
		await appendRunEvent(ref, {
			type: "run.mark_background",
			status: record.status,
			message: "run marked background",
		});
		const snapshot = await getRunStatus(ref);
		return textResult(
			{
				tool: TOOL_NAME,
				action,
				status: snapshot?.status ?? record.status,
				snapshot,
			},
			false,
			{ snapshot, record },
		);
	}

	if (action === "interrupt") {
		const signal = optionalString(raw.signal, "signal") as
			| NodeJS.Signals
			| undefined;
		if (
			signal !== undefined &&
			signal !== "SIGINT" &&
			signal !== "SIGTERM" &&
			signal !== "SIGKILL"
		) {
			throw new InputValidationError(
				'signal must be one of "SIGINT", "SIGTERM", or "SIGKILL" when provided.',
			);
		}
		const interrupted = await interruptRun({
			cwd: ref.cwd,
			runId,
			runsDir: ref.runsDir,
			attemptId: ref.attemptId,
			reason: optionalString(raw.reason, "reason"),
			signal,
			escalateAfterMs: optionalPositiveNumber(
				raw.escalateAfterMs,
				"escalateAfterMs",
			),
			killAfterMs: optionalPositiveNumber(raw.killAfterMs, "killAfterMs"),
		});
		const snapshot = await getRunStatus(ref);
		const isError =
			interrupted.status === "not-found" ||
			interrupted.status === "unsupported";
		return textResult(
			{
				tool: TOOL_NAME,
				action,
				status: interrupted.status,
				interrupted,
				snapshot,
			},
			isError,
			{ interrupted, snapshot },
		);
	}

	if (action === "reconcile") {
		const reconciled = await reconcileSubagentRun(ref);
		const snapshot = await getRunStatus(ref);
		return textResult(
			{
				tool: TOOL_NAME,
				action,
				status: reconciled.status,
				reconciled,
				snapshot,
			},
			reconciled.status === "not-found",
			{ reconciled, snapshot },
		);
	}

	const waited = await waitForRun({
		...ref,
		timeoutMs: optionalPositiveNumber(raw.timeoutMs, "timeoutMs"),
		pollIntervalMs: optionalPositiveNumber(
			raw.pollIntervalMs,
			"pollIntervalMs",
		),
	});
	const isError =
		waited.status !== "completed" || waited.snapshot?.status !== "completed";
	return textResult(
		{
			tool: TOOL_NAME,
			action,
			status: waited.status,
			outcome: waited.outcome,
			snapshot: waited.snapshot,
		},
		isError,
		{ waited },
	);
}

function executionMode(input: ResolveInput): ExecutionMode {
	if (input.mode !== undefined) return input.mode;
	if (input.tasks !== undefined) return "parallel";
	return "single";
}

function unsupportedPathError(
	raw: Record<string, unknown>,
	input: ResolveInput,
	backend: ResolvedBackend,
): string | undefined {
	const mode = executionMode(input);
	const unknownKeys = Object.keys(raw).filter(
		(key) => !SUPPORTED_KEYS.has(key),
	);
	if (unknownKeys.length > 0) {
		return `unsupported subagent option(s): ${formatKeyList(unknownKeys)}.`;
	}

	if (mode === "parallel") {
		return input.tasks === undefined
			? "parallel mode requires a non-empty tasks array."
			: undefined;
	}

	if (
		backend !== "inline" &&
		backend !== "headless" &&
		backend !== "tmux" &&
		backend !== "herdr"
	) {
		return `backend "${backend}" is not implemented in this MVP; only inline, headless, tmux, and herdr execution are supported.`;
	}

	if (hasAnyKey(raw, AGENT_TASK_KEYS) && input.task === undefined) {
		return `${backend} agent/task execution requires a non-empty "task".`;
	}

	if (!hasAnyKey(raw, AGENT_TASK_KEYS)) {
		return `${backend} execution requires agent/task input.`;
	}

	return undefined;
}

async function writeUnsupportedResult(
	cwd: string,
	backend: ResolvedBackend,
	input: ResolveInput,
): Promise<ResultEnvelope> {
	const startedAt = new Date();
	const store = await createAttemptArtifactStore({
		cwd,
		runsDir: input.runsDir,
	});
	const sandboxed = Boolean(input.sandbox);
	return await store.writeResult({
		backend,
		status: "failed",
		failureKind: "validation",
		cwd,
		startedAt,
		completedAt: new Date(),
		workspace: { mode: "shared", cwd },
		sandbox: { enabled: sandboxed },
		exitCode: null,
		signal: null,
		artifacts: [],
		correlationId: input.correlationId,
		metadata: { contextLengthExceeded: false },
	});
}

type ToolUpdateCallback = (update: {
	content: ToolTextContent[];
	details: unknown;
}) => void;

interface NotificationContext {
	ui?: {
		notify?: (message: string, level?: "info" | "warning" | "error") => void;
	};
}

interface ProjectAgentApprovalContext extends NotificationContext {
	hasUI?: boolean;
	ui?: NotificationContext["ui"] & {
		confirm?: (title: string, message?: string) => Promise<boolean> | boolean;
	};
}

interface AgentRequest {
	agent: string;
	cwd?: string;
	agentScope?: ResolveInput["agentScope"];
	confirmProjectAgents?: boolean;
}

function agentRequests(input: ResolveInput): AgentRequest[] {
	if (input.tasks !== undefined) {
		return input.tasks
			.filter(
				(task): task is typeof task & { agent: string } =>
					typeof task.agent === "string" && task.agent.length > 0,
			)
			.map((task) => ({
				agent: task.agent,
				cwd: task.cwd,
				agentScope: task.agentScope ?? input.agentScope,
				confirmProjectAgents:
					task.confirmProjectAgents ?? input.confirmProjectAgents ?? false,
			}));
	}
	return typeof input.agent === "string" && input.agent.length > 0
		? [
				{
					agent: input.agent,
					cwd: input.cwd,
					agentScope: input.agentScope,
					confirmProjectAgents: input.confirmProjectAgents ?? false,
				},
			]
		: [];
}

async function maybeConfirmProjectAgents(
	input: ResolveInput,
	cwd: string,
	ctx?: ProjectAgentApprovalContext,
): Promise<void> {
	const projectAgents: AgentDefinition[] = [];
	for (const request of agentRequests(input)) {
		if (
			request.confirmProjectAgents === false ||
			request.agentScope === "global"
		)
			continue;
		const requestCwd = resolve(cwd, request.cwd ?? ".");
		const agent = await loadAgentByName(
			request.agent,
			requestCwd,
			request.agentScope,
		);
		if (
			agent?.source === "project" &&
			!projectAgents.some(
				(candidate) => candidate.sourcePath === agent.sourcePath,
			)
		) {
			projectAgents.push(agent);
		}
	}
	if (projectAgents.length === 0) return;

	const names = projectAgents.map((agent) => agent.displayName).join(", ");
	const sources = projectAgents.map((agent) => agent.sourcePath).join("\n");
	if (ctx?.hasUI && ctx.ui?.confirm) {
		const approved = await ctx.ui.confirm(
			"Run project-local subagent definitions?",
			`Agents: ${names}\nSources:\n${sources}\n\nProject agents are repository-controlled. Continue only for trusted repositories.`,
		);
		if (!approved)
			throw new Error(
				"Canceled: project-local subagent definitions were not approved.",
			);
		return;
	}

	throw new Error(
		"Project-local subagent definitions require interactive approval or confirmProjectAgents:false.",
	);
}

function completionPayload(result: ResultEnvelope, mode: ExecutionMode) {
	return {
		tool: TOOL_NAME,
		event: "complete",
		mode,
		runId: result.runId,
		attemptId: result.attemptId,
		backend: result.backend,
		status: result.status,
		failureKind: result.failureKind,
		artifacts: artifactSummary(result.artifacts),
	};
}

function notifyCompletion(
	input: ResolveInput,
	result: ResultEnvelope,
	mode: ExecutionMode,
	onUpdate?: ToolUpdateCallback,
	ctx?: NotificationContext,
): number {
	if (input.onComplete !== "notify") return 0;
	const payload = completionPayload(result, mode);
	let updatesSent = 0;
	try {
		onUpdate?.({
			content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			details: payload,
		});
		if (onUpdate) updatesSent += 1;
	} catch {
		// Completion notifications must not change the task result.
	}
	try {
		ctx?.ui?.notify?.(
			`subagent ${result.runId}/${result.attemptId} ${result.status}`,
			result.status === "completed" ? "info" : "warning",
		);
		if (ctx?.ui?.notify) updatesSent += 1;
	} catch {
		// Completion notifications must not change the task result.
	}
	return updatesSent;
}

export default function registerSubagentEngine(pi: ExtensionAPI) {
	registerSubagentWatchShortcuts(pi);
	if (typeof pi.on === "function") {
		pi.on("tool_execution_start", (event, ctx) => {
			if (event.toolName !== TOOL_NAME || !isRunAction(event.args)) return;
			const requestedCwd =
				isRecord(event.args) &&
				typeof event.args.cwd === "string" &&
				event.args.cwd.length > 0
					? event.args.cwd
					: ctx.cwd;
			attachProgress(event.toolCallId, requestedCwd, () => undefined);
		});
		pi.on("tool_execution_end", (event) => {
			if (event.toolName !== TOOL_NAME) return;
			// Keep the final cached snapshot for the settled row; the tracker
			// auto-detaches after observing the terminal result.
		});
		pi.on("session_shutdown", () => {
			resetProgress();
		});
		pi.on("session_start", async (_event, ctx) => {
			setSubagentToolEnabled(pi, isSubagentToolEnabled(pi, ctx), ctx);
			await refreshSubagentCatalog(pi, ctx.cwd);
		});
		pi.on("session_tree", async (_event, ctx) => {
			setSubagentToolEnabled(pi, isSubagentToolEnabled(pi, ctx), ctx);
			await refreshSubagentCatalog(pi, ctx.cwd);
		});
	}
	if (typeof pi.registerCommand === "function") {
		pi.registerCommand("subagent", {
			description:
				"Subagent utilities. Use `/subagent enable|disable` to control LLM exposure, `/subagent panel` for status, or `/subagent watch [1-9]` for a live run.",
			getArgumentCompletions(prefix) {
				const items = [
					{
						value: "enable",
						label: "enable",
						description: "Expose the subagent tool to the LLM for this session",
					},
					{
						value: "disable",
						label: "disable",
						description: "Hide the subagent tool from the LLM for this session",
					},
					{
						value: "panel",
						label: "panel",
						description: "Open the live Subagents status panel",
					},
					{
						value: "watch",
						label: "watch [number]",
						description: "Open one subagent run in a modal",
					},
				];
				const filtered = items.filter((item) =>
					item.value.startsWith(prefix.trim()),
				);
				return filtered.length > 0 ? filtered : null;
			},
			async handler(args, ctx) {
				const commandArgs = args.trim();
				const normalizedArgs = commandArgs
					.replace(/^\/?subagent\b\s*/, "")
					.trim();
				if (normalizedArgs === "enable" || normalizedArgs === "disable") {
					const enabled = normalizedArgs === "enable";
					setSubagentToolEnabled(pi, enabled, ctx);
					ctx.ui.notify?.(
						enabled
							? "Subagent tool enabled for this session."
							: "Subagent tool disabled for this session; it is hidden from the LLM.",
						"info",
					);
					return;
				}
				if (normalizedArgs === "panel") {
					await showSubagentPanel(ctx);
					return;
				}
				const watchMatch = /^watch(?:\s+([1-9]))?$/.exec(normalizedArgs);
				if (watchMatch !== null) {
					await openSubagentWatch(ctx, Number(watchMatch[1] ?? "1") - 1);
					return;
				}
				ctx.ui.notify?.(
					"Usage: /subagent enable|disable|panel or /subagent watch [1-9]",
					"warning",
				);
			},
		});
	}

	pi.registerTool(buildSubagentToolDefinition(DEFAULT_SUBAGENT_DESCRIPTION, []));
	void refreshSubagentCatalog(pi, process.cwd());
}

const DEFAULT_SUBAGENT_DESCRIPTION = [
	"Subagent engine. Executes headless/tmux/herdr/inline workers; supports workspace:auto/worktree isolation, bounded parallel fanout, async lifecycle lookup, mark-background, reconcile, and conservative interrupt. Workspaces default to shared; set worktree:true for parallel tasks that mutate files.",
	"",
	"{CATALOG}",
].join("\n");

type SubagentToolDefinition = ToolDefinition<any, any, any>;

/**
 * Refresh the LLM-facing subagent catalog for a working directory. Discovers
 * global + project agent profiles and re-registers the tool so its description
 * and prompt guidelines list every available profile. No-op when unchanged.
 */
interface CatalogRefreshState {
	lastDescription: string;
	requestId: number;
	enabledBySession: Map<string, boolean>;
}

const catalogRefreshStates = new WeakMap<object, CatalogRefreshState>();

function catalogStateFor(pi: ExtensionAPI): CatalogRefreshState {
	const existing = catalogRefreshStates.get(pi as object);
	if (existing !== undefined) return existing;
	const created: CatalogRefreshState = {
		lastDescription: "",
		requestId: 0,
		enabledBySession: new Map(),
	};
	catalogRefreshStates.set(pi as object, created);
	return created;
}

function sessionKey(ctx: unknown): string {
	if (isRecord(ctx)) {
		const sessionManager = ctx.sessionManager;
		if (isRecord(sessionManager) && typeof sessionManager.getSessionId === "function") {
			try {
				const id = sessionManager.getSessionId();
				if (typeof id === "string" && id.length > 0) return id;
			} catch {
				// Fall back to the extension instance when session metadata is unavailable.
			}
		}
	}
	return "__current__";
}

function setSubagentToolEnabled(
	pi: ExtensionAPI,
	enabled: boolean,
	ctx: unknown,
): void {
	const state = catalogStateFor(pi);
	state.enabledBySession.set(sessionKey(ctx), enabled);
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
		return;
	}
	const active = pi.getActiveTools();
	const next = enabled
		? active.includes(TOOL_NAME)
			? active
			: [...active, TOOL_NAME]
		: active.filter((name) => name !== TOOL_NAME);
	if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
		pi.setActiveTools(next);
	}
}

function isSubagentToolEnabled(pi: ExtensionAPI, ctx: unknown): boolean {
	return catalogStateFor(pi).enabledBySession.get(sessionKey(ctx)) ?? true;
}

async function refreshSubagentCatalog(
	pi: ExtensionAPI,
	cwd: string,
): Promise<void> {
	const state = catalogStateFor(pi);
	const requestId = ++state.requestId;
	try {
		const { agents } = await discoverSubagentCatalog(cwd);
		if (requestId !== state.requestId) return;
		const description = DEFAULT_SUBAGENT_DESCRIPTION.replace(
			"{CATALOG}",
			formatAgentCatalogText(agents),
		);
		if (description === state.lastDescription) return;
		const guidelines =
			agents.length === 0
				? []
				: [
						"When delegating to a subagent, prefer a named profile from the subagent tool description whose purpose matches the task. Never invent profile names. Omit agent to run an unnamed general-purpose worker.",
					];
		pi.registerTool(buildSubagentToolDefinition(description, guidelines));
		state.lastDescription = description;
	} catch {
		// Catalog refresh must never break session startup.
	}
}

function buildSubagentToolDefinition(
	description: string,
	promptGuidelines: string[],
): SubagentToolDefinition {
	return {
		name: TOOL_NAME,
		label: "Subagent",
		description,
		promptGuidelines,
		parameters: Type.Object({
			backend: Type.Optional(
				Type.Union(BACKENDS.map((value) => Type.Literal(value))),
			),
			visible: Type.Optional(Type.Boolean()),
			sandbox: Type.Optional(SANDBOX_SCHEMA),
			agent: Type.Optional(Type.String({ minLength: 1 })),
			task: Type.Optional(Type.String({ minLength: 1 })),
			roleContext: Type.Optional(Type.String({ minLength: 1 })),
			agentScope: Type.Optional(
				Type.Union(AGENT_SCOPES.map((value) => Type.Literal(value))),
			),
			confirmProjectAgents: Type.Optional(Type.Boolean()),
			mode: Type.Optional(
				Type.Union(EXECUTION_MODES.map((value) => Type.Literal(value))),
			),
			tasks: Type.Optional(Type.Array(SUBAGENT_TASK_SCHEMA, { minItems: 1 })),
			concurrency: Type.Optional(
				Type.Number({
					minimum: 1,
					description: `Maximum parallel runs to launch at once. Default ${DEFAULT_PARALLEL_CONCURRENCY}.`,
				}),
			),
			failFast: Type.Optional(
				Type.Boolean({
					description:
						"For synchronous parallel runs, stop scheduling additional siblings after the first failed result.",
				}),
			),
			cancelSiblingsOnFailure: Type.Optional(
				Type.Boolean({
					description:
						"For synchronous parallel runs, abort already-running siblings after the first failed result. Implies fail-fast scheduling.",
				}),
			),
			asyncDependency: Type.Optional(
				Type.Union(
					ASYNC_DEPENDENCIES.map((value) => Type.Literal(value)),
					{
						description:
							"Whether an async run is needed before final, background, or unclassified.",
					},
				),
			),
			workspace: Type.Optional(
				Type.Union([
					Type.Union(WORKSPACE_MODES.map((value) => Type.Literal(value))),
					Type.Object({
						mode: Type.Optional(
							Type.Union(WORKSPACE_MODES.map((value) => Type.Literal(value))),
						),
						path: Type.Optional(Type.String({ minLength: 1 })),
					}),
				]),
			),
			worktree: Type.Optional(
				Type.Union([Type.Boolean(), Type.String({ minLength: 1 })]),
			),
			worktreePolicy: Type.Optional(
				Type.Union(WORKTREE_POLICIES.map((value) => Type.Literal(value))),
			),
			cwd: Type.Optional(Type.String({ minLength: 1 })),
			async: Type.Optional(Type.Boolean()),
			onComplete: Type.Optional(
				Type.Union(ON_COMPLETE_ACTIONS.map((value) => Type.Literal(value))),
			),
			model: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Optional Pi model pattern or provider/model id for model-backed subagents.",
				}),
			),
			tools: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Optional tool allowlist. With a named agent this may only narrow the agent-declared tools. Use [] to disable tools.",
				}),
			),
			systemPrompt: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Optional compiled system prompt. When provided, it replaces the named agent prompt body but not agent frontmatter policy.",
				}),
			),
			skills: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Additional Pi skill paths to load. Omit to use ambient discovery; pass [] to disable child skills.",
				}),
			),
			extensions: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Additional Pi extension paths to load. Omit to use ambient discovery; pass [] to disable child extensions.",
				}),
			),
			runsDir: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Safe relative run/artifact root under cwd.",
				}),
			),
			correlationId: Type.Optional(
				Type.String({
					minLength: 1,
					description: "External correlation label; no aggregation semantics.",
				}),
			),
			captureToolCalls: Type.Optional(
				Type.Boolean({
					description:
						"Capture redacted child tool-call telemetry (tool names, durations, statuses; no args/results) as run artifacts. Default false.",
				}),
			),
			thinking: Type.Optional(
				Type.Union(
					THINKING_LEVELS.map((value) => Type.Literal(value)),
					{ description: "Optional Pi thinking/reasoning level." },
				),
			),
			thinkingLevel: Type.Optional(
				Type.Union(
					THINKING_LEVELS.map((value) => Type.Literal(value)),
					{ description: "Alias for thinking." },
				),
			),
			reasoningLevel: Type.Optional(
				Type.Union(
					THINKING_LEVELS.map((value) => Type.Literal(value)),
					{ description: "Alias for thinking." },
				),
			),
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("run"),
						Type.Literal("agents"),
						Type.Literal("runs"),
						Type.Literal("status"),
						Type.Literal("logs"),
						Type.Literal("wait"),
						Type.Literal("interrupt"),
						Type.Literal("mark-background"),
						Type.Literal("reconcile"),
					],
					{
						default: "run",
						description:
							'What to do. Default "run" starts a new subagent. agents lists discovered profiles. status/logs/wait/interrupt/mark-background/reconcile operate on an existing runId.',
					},
				),
			),
			runId: Type.Optional(Type.String({ minLength: 1 })),
			attemptId: Type.Optional(Type.String({ minLength: 1 })),
			taskId: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Deprecated alias for attemptId when reading old runs.",
				}),
			),
			pollIntervalMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
			reason: Type.Optional(Type.String({ minLength: 1 })),
			signal: Type.Optional(
				Type.Union([
					Type.Literal("SIGINT"),
					Type.Literal("SIGTERM"),
					Type.Literal("SIGKILL"),
				]),
			),
			scope: Type.Optional(
				Type.Union(
					[
						Type.Literal("session"),
						Type.Literal("cwd"),
						Type.Literal("all"),
					],
					{
						description:
							'With action:"runs", restrict the listing to the current session (default), the current cwd, or all located runs. Ignored otherwise.',
					},
				),
			),
			limit: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 50,
					description:
						"With action:\"runs\", maximum number of runs to return (default 10, max 50). Ignored otherwise.",
				}),
			),
		}),
		renderCall(args, theme, context) {
			if (isLogsAction(args)) return new HiddenComponent();
			const title = theme.fg("toolTitle", theme.bold("subagent"));
			const summary = subagentCallSummary(args);
			const rest = summary.startsWith("subagent ")
				? summary.slice("subagent ".length)
				: summary;
			const base = `${title} ${theme.fg("muted", rest)}`;
			if (
				isRunAction(args) &&
				context?.toolCallId &&
				typeof context.invalidate === "function"
			) {
				const requestedCwd =
					isRecord(args) &&
					typeof args.cwd === "string" &&
					args.cwd.length > 0
						? args.cwd
						: context.cwd;
				attachProgress(context.toolCallId, requestedCwd, () =>
					context.invalidate(),
				);
				return new ProgressLineComponent(base, () =>
					getProgress(context.toolCallId),
				);
			}
			return new SingleLineComponent(base);
		},
		renderResult(result, options, theme, context) {
			const payload = result.details ?? (() => {
				const text = result.content.find(
					(item): item is ToolTextContent => item.type === "text",
				)?.text;
				if (text === undefined) return undefined;
				try {
					return JSON.parse(text) as unknown;
				} catch {
					return text;
				}
			})();
			const summary = resultSummary(
				isRecord(payload) && "result" in payload ? payload.result : payload,
			);
			const settledStatus =
				isRecord(payload) && "result" in payload && isRecord(payload.result)
					? payload.result.status
					: isRecord(payload)
						? payload.status
						: undefined;
			if (
				isLogsAction(context?.args) ||
				(isRecord(payload) && payload.action === "logs")
			)
				return new HiddenComponent();
			const color = options.isPartial
				? "warning"
				: settledStatus === "failed" || settledStatus === "cancelled"
					? "error"
					: "success";
			return new SingleLineComponent(theme.fg(color, summary));
		},
		async execute(...executeArgs: unknown[]) {
			const { params, signal, onUpdate, ctx } =
				normalizeExecuteArgs(executeArgs);
			const cwd = getCwd(ctx);

			try {
				const raw = isRecord(params) ? params : {};
				const parentSessionId = parentSessionIdFromCtx(ctx);
				const lifecycle = await lifecycleAction(raw, cwd, parentSessionId);
				if (lifecycle !== null) return lifecycle;

				const validation = validateResolveInput(params);
				if (!validation.ok) return validationFailure(validation.failure);

				if (parentSessionId !== undefined)
					validation.input.parentSessionId = parentSessionId;
				const profileCwd = resolve(validation.input.cwd ?? cwd);
				const profiled = await applyAgentRuntimeDefaults(
					validation.input,
					profileCwd,
				);
				Object.assign(validation.input, profiled.input);

				const resolved = resolveBackend(validation.input);
				if (resolved.status === "failed") return validationFailure(resolved);

				const unsupportedError = unsupportedPathError(
					raw,
					validation.input,
					resolved.backend,
				);
				if (unsupportedError) {
					const result = await writeUnsupportedResult(
						cwd,
						resolved.backend,
						validation.input,
					);
					return textResult(compactResult(result, unsupportedError), true, {
						result,
						resolved,
					});
				}

				const runCwd = validation.input.cwd ?? cwd;
				await maybeConfirmProjectAgents(
					validation.input,
					runCwd,
					ctx as ProjectAgentApprovalContext,
				);
				const mode = executionMode(validation.input);
				const asyncRequested =
					validation.input.async === true ||
					validation.input.onComplete === "detach" ||
					validation.input.onComplete === "notify";
				if (mode === "parallel") {
					const parallel = asyncRequested
						? await startAsyncParallelSubagentRuns(
								validation.input,
								runCwd,
								signal,
								(completed, completedMode) =>
									notifyCompletion(
										validation.input,
										completed,
										completedMode,
										onUpdate,
										ctx as NotificationContext,
									),
							)
						: await runParallelSubagentTasks(validation.input, runCwd, signal);
					const runs = parallel.results.map((result) => compactResult(result));
					const failed =
						!asyncRequested &&
						(parallel.failFastTriggered ||
							parallel.results.some((result) => result.status !== "completed"));
					return textResult(
						{
							tool: TOOL_NAME,
							mode: "parallel",
							status: failed
								? "failed"
								: asyncRequested
									? "running"
									: "completed",
							runIds: parallel.runIds,
							concurrencyLimit: parallel.concurrency,
							totalTasks: parallel.totalTasks,
							startedCount: parallel.startedCount,
							skippedCount: parallel.skippedCount,
							failFastTriggered: parallel.failFastTriggered,
							runs,
						},
						failed,
						{ results: parallel.results, resolved },
					);
				}

				if (asyncRequested) {
					const result = await startAsyncSubagentRun({
						input: validation.input,
						cwd: runCwd,
						backend: resolved.backend,
						signal,
						onComplete: (completed, completedMode) =>
							notifyCompletion(
								validation.input,
								completed,
								completedMode,
								onUpdate,
								ctx as NotificationContext,
							),
					});
					return textResult(compactResult(result), false, { result, resolved });
				}

				const result = await runSubagentTask({
					input: validation.input,
					cwd: runCwd,
					signal,
				});
				return textResult(
					compactResult(result),
					result.status !== "completed",
					{ result, resolved },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const failureKind =
					error instanceof WorkspacePolicyError ||
					error instanceof InputValidationError
						? error.failureKind
						: typeof error === "object" &&
								error !== null &&
								(error as { failureKind?: unknown }).failureKind ===
									"validation"
							? "validation"
							: "internal";
				return textResult(
					{
						tool: TOOL_NAME,
						status: "failed",
						failureKind,
						error: message,
					},
					true,
				);
			}
		},
	};
}
