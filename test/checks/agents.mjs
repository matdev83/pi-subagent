#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentSystemPrompt, loadAgentByName } from "../../src/agents.ts";
import { buildPiArgv } from "../../src/runners/headless-model.ts";
import { resolveEffectiveTools } from "../../src/orchestrate/run.ts";
import { runSubagent } from "../../api.mjs";
import { createJiti } from "jiti";
import {
	catalogEntries,
	formatAgentCatalogText,
} from "../../src/catalog.ts";

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
});
const extensionModule = await jiti.import("../../src/index.ts");
const registerSubagentEngine = extensionModule.default ?? extensionModule;

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-agents-"));
try {
	const sharedAgentsDir = join(tempRoot, ".pi", "agents");
	await mkdir(sharedAgentsDir, { recursive: true });
	await writeFile(
		join(sharedAgentsDir, "inherited.md"),
		`---
name: inherited
---
SHOULD_NOT_LOAD_FROM_SHARED_PARENT
`,
	);

	const emptyRepo = join(tempRoot, "empty-repo");
	await mkdir(join(emptyRepo, ".git"), { recursive: true });
	const inherited = await loadAgentByName("inherited", emptyRepo, "project");
	assert.equal(
		inherited,
		undefined,
		"project agents must not be inherited from above the git boundary",
	);

	const cwd = join(tempRoot, "repo");
	await mkdir(join(cwd, ".git"), { recursive: true });
	const agentsDir = join(cwd, ".pi", "agents", "review");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(
		join(agentsDir, "security.md"),
		`---
name: security-reviewer
description: Security specialist for check coverage
backend: headless
model: check-provider/check-model
thinking: high
tools:
  - read
  - grep
systemPromptMode: append
---
SMOKE_AGENT_PROMPT_MARKER
Always mention injected-agent-ok.
`,
	);

	const agent = await loadAgentByName("review.security", cwd, "project");
	assert.ok(agent, "project agent should load by dotted path alias");
	assert.equal(agent.name, "security-reviewer");
	assert.equal(agent.backend, "headless");

	const catalog = formatAgentCatalogText([agent]);
	assert.match(catalog, /review\.security/);
	assert.match(catalog, /Security specialist for check coverage/);
	assert.match(catalog, /backend headless/);
	assert.match(catalog, /model check-provider\/check-model/);
	assert.match(catalog, /tools: read,grep/);
	assert.deepEqual(catalogEntries([agent]), [
		{
			name: "review.security",
			description: "Security specialist for check coverage",
			source: "project",
			model: "check-provider/check-model",
			backend: "headless",
			thinking: "high",
			tools: ["read", "grep"],
		},
	]);
	assert.match(
		formatAgentCatalogText([]),
		/No named subagent profiles are configured/,
	);

	const registeredTools = [];
	const handlers = new Map();
	registerSubagentEngine({
		registerTool(tool) {
			registeredTools.push(tool);
		},
		on(name, handler) {
			handlers.set(name, handler);
		},
	});
	const sessionStart = handlers.get("session_start");
	assert.equal(typeof sessionStart, "function");
	await sessionStart({}, { cwd });
	const dynamicTool = registeredTools.at(-1);
	assert.ok(dynamicTool, "catalog refresh should re-register the tool");
	assert.match(dynamicTool.description, /review\.security/);
	assert.match(dynamicTool.description, /Security specialist for check coverage/);
	const catalogResult = await dynamicTool.execute(
		"catalog-test",
		{ action: "agents", cwd },
		() => {},
		{ cwd },
		new AbortController().signal,
	);
	const catalogPayload = JSON.parse(catalogResult.content[0].text);
	assert.equal(catalogPayload.action, "agents");
	assert.equal(catalogPayload.cwd, cwd);
	assert.ok(
		catalogPayload.agents.some((entry) => entry.name === "review.security"),
		"action:agents should expose the discovered profile catalog",
	);
	assert.equal(agent.source, "project");
	assert.equal(agent.model, "check-provider/check-model");
	assert.equal(agent.thinking, "high");
	assert.deepEqual(agent.tools, ["read", "grep"]);
	assert.match(buildAgentSystemPrompt(agent), /SMOKE_AGENT_PROMPT_MARKER/);

	const argv = buildPiArgv({
		agent: "review.security",
		task: "check injection",
		cwd,
		agentDefinition: agent,
	});
	assert.deepEqual(
		argv.slice(
			argv.indexOf("--exclude-tools"),
			argv.indexOf("--exclude-tools") + 2,
		),
		["--exclude-tools", "subagent"],
	);
	assert.equal(
		argv.includes("--no-extensions"),
		false,
		"ambient extensions should be loaded by default",
	);
	assert.equal(
		argv.includes("--no-skills"),
		false,
		"ambient skills should be loaded by default",
	);
	const appendIndex = argv.indexOf("--append-system-prompt");
	assert.ok(appendIndex > 0, "agent system prompt should be appended");
	assert.match(argv[appendIndex + 1], /SMOKE_AGENT_PROMPT_MARKER/);
	assert.deepEqual(
		argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2),
		["--model", "check-provider/check-model"],
	);
	assert.deepEqual(
		argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 2),
		["--thinking", "high"],
	);
	assert.deepEqual(
		argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2),
		["--tools", "read,grep"],
	);
	assert.equal(argv.includes("--no-tools"), false);

	const narrowedOverrideArgv = buildPiArgv({
		agent: "review.security",
		task: "check narrowed override",
		cwd,
		agentDefinition: agent,
		tools: ["read"],
	});
	assert.deepEqual(
		narrowedOverrideArgv.slice(
			narrowedOverrideArgv.indexOf("--tools"),
			narrowedOverrideArgv.indexOf("--tools") + 2,
		),
		["--tools", "read"],
	);

	const noToolsArgv = buildPiArgv({
		agent: "review.security",
		task: "check no tools",
		cwd,
		agentDefinition: agent,
		tools: [],
	});
	assert.equal(noToolsArgv.includes("--tools"), false);
	assert.equal(noToolsArgv.includes("--no-tools"), true);

	const agentsOpenDir = join(cwd, ".pi", "agents");
	await writeFile(
		join(agentsOpenDir, "open.md"),
		`---
name: open-agent
description: Agent with no tool declaration
---
OPEN_AGENT_PROMPT_MARKER
`,
	);
	const openAgent = await loadAgentByName("open", cwd, "project");
	assert.ok(openAgent, "agent without tools should load");
	assert.equal(openAgent.tools, undefined);
	assert.equal(catalogEntries([openAgent])[0].tools, null);
	const openArgv = buildPiArgv({
		agent: "open",
		task: "check default tools",
		cwd,
		agentDefinition: openAgent,
		tools: ["read"],
	});
	assert.deepEqual(
		openArgv.slice(
			openArgv.indexOf("--tools"),
			openArgv.indexOf("--tools") + 2,
		),
		["--tools", "read"],
	);

	const agentlessArgv = buildPiArgv({
		agent: "headless-worker",
		task: "check agentless tools",
		cwd,
		tools: ["read"],
	});
	assert.deepEqual(
		agentlessArgv.slice(
			agentlessArgv.indexOf("--tools"),
			agentlessArgv.indexOf("--tools") + 2,
		),
		["--tools", "read"],
	);

	const agentlessNoToolsArgv = buildPiArgv({
		agent: "headless-worker",
		task: "check agentless no tools",
		cwd,
		tools: [],
	});
	assert.equal(agentlessNoToolsArgv.includes("--tools"), false);
	assert.equal(agentlessNoToolsArgv.includes("--no-tools"), true);

	const noAgentArgv = buildPiArgv({
		agent: "missing-compatible",
		task: "check default tools",
		cwd,
	});
	assert.equal(
		noAgentArgv.includes("--tools"),
		false,
		"missing agent definition without call tools should not constrain tools",
	);
	assert.equal(
		noAgentArgv.includes("--no-tools"),
		false,
		"missing agent definition without call tools should not disable tools",
	);

	const explicitPromptArgv = buildPiArgv({
		agent: "review.security",
		task: "raw task prompt",
		cwd,
		agentDefinition: agent,
		systemPrompt: "COMPILED_SYSTEM_PROMPT",
		skills: ["/tmp/skill"],
		extensions: ["/tmp/ext.ts"],
	});
	assert.equal(
		explicitPromptArgv.includes("--append-system-prompt"),
		false,
		"systemPrompt should suppress agent prompt append",
	);
	assert.deepEqual(
		explicitPromptArgv.slice(
			explicitPromptArgv.indexOf("--system-prompt"),
			explicitPromptArgv.indexOf("--system-prompt") + 2,
		),
		["--system-prompt", "COMPILED_SYSTEM_PROMPT"],
	);
	assert.deepEqual(
		explicitPromptArgv.slice(
			explicitPromptArgv.indexOf("--skill"),
			explicitPromptArgv.indexOf("--skill") + 2,
		),
		["--skill", "/tmp/skill"],
	);
	assert.deepEqual(
		explicitPromptArgv.slice(
			explicitPromptArgv.indexOf("--extension"),
			explicitPromptArgv.indexOf("--extension") + 2,
		),
		["--extension", "/tmp/ext.ts"],
	);
	assert.equal(explicitPromptArgv.includes("--no-skills"), false);
	assert.equal(explicitPromptArgv.includes("--no-extensions"), false);
	assert.match(explicitPromptArgv.at(-1), /^raw task prompt$/);

	const hermeticArgv = buildPiArgv({
		agent: "review.security",
		task: "hermetic child",
		cwd,
		agentDefinition: agent,
		skills: [],
		extensions: [],
	});
	assert.equal(
		hermeticArgv.includes("--no-skills"),
		true,
		"skills: [] should disable child skills",
	);
	assert.equal(
		hermeticArgv.includes("--no-extensions"),
		true,
		"extensions: [] should disable child extensions",
	);

	assert.deepEqual(
		resolveEffectiveTools({ tools: ["read", "write"] }, agent),
		["read"],
		"call and profile tool lists should be intersected",
	);
	assert.deepEqual(
		resolveEffectiveTools({ tools: ["write"] }, agent),
		[],
		"a disjoint call list should disable all tools rather than expand authority",
	);

	const inheritedToolsResult = await runSubagent({
		cwd,
		backend: "inline",
		agent: "open",
		agentScope: "project",
		confirmProjectAgents: false,
		task: "check inherited tools",
		tools: [],
	});
	assert.notEqual(
		inheritedToolsResult.failureKind,
		"validation",
		"an agent without tools should permit call-level narrowing",
	);

	await writeFile(
		join(agentsOpenDir, "disabled.md"),
		`---
name: disabled-agent
tools:
---
DISABLED_AGENT_PROMPT_MARKER
`,
	);
	const disabledAgent = await loadAgentByName("disabled", cwd, "project");
	assert.ok(disabledAgent);
	assert.equal(
		disabledAgent.tools,
		undefined,
		"an explicit empty tools list should inherit all ambient tools",
	);
	const permissiveArgv = buildPiArgv({
		agent: "disabled",
		task: "check permissive empty tools",
		cwd,
		agentDefinition: disabledAgent,
		tools: disabledAgent.tools,
	});
	assert.equal(permissiveArgv.includes("--tools"), false);
	assert.equal(permissiveArgv.includes("--no-tools"), false);

	const globalOnly = await loadAgentByName("review.security", cwd, "global");
	assert.equal(
		globalOnly,
		undefined,
		"global scope should not load project agent",
	);

	console.log(
		JSON.stringify(
			{ name: "check-agents", status: "completed", agent: agent.displayName },
			null,
			2,
		),
	);
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}
