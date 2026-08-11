// Automatic subagent profile catalog.
//
// Discovers the agent definition files for a working directory (global +
// project) and formats them for LLM-facing surfaces so callers never have to
// guess or manually discover profile names. Two outputs are produced:
//
// - `formatAgentCatalogText`: a compact plain-text block embedded in the
//   subagent tool description (and returned by action:"agents").
// - `catalogEntries`: structured entries for the action:"agents" JSON result.
//
// Catalog refresh happens in the extension runtime (src/index.ts), which
// re-registers the subagent tool whenever the session working directory or the
// discovered agent set changes.

import {
	discoverAgents,
	type AgentDefinition,
	type AgentSource,
} from "./agents.ts";
import type { ThinkingLevel } from "./core/constants.ts";

const MAX_ENTRY_DESCRIPTION = 110;
const MAX_CATALOG_CHARS = 6000;

export interface CatalogEntry {
	name: string;
	description: string | null;
	source: AgentSource;
	model: string | null;
	backend: AgentDefinition["backend"] | null;
	thinking: ThinkingLevel | null;
	tools: string[] | null;
}

export async function discoverSubagentCatalog(
	cwd: string,
): Promise<{ agents: AgentDefinition[]; projectAgentsDir: string | null }> {
	const registry = await discoverAgents(cwd);
	return { agents: registry.agents, projectAgentsDir: registry.projectAgentsDir };
}

export function catalogEntries(agents: AgentDefinition[]): CatalogEntry[] {
	return agents
		.slice()
		.sort((left, right) => left.displayName.localeCompare(right.displayName))
		.map((agent) => ({
		name: agent.displayName,
		description:
			agent.description === undefined
				? null
				: oneLine(agent.description, MAX_ENTRY_DESCRIPTION),
		source: agent.source,
		model: agent.model ?? null,
		backend: agent.backend ?? null,
		thinking: agent.thinking ?? null,
		tools:
			agent.tools !== undefined && agent.tools.length > 0
				? agent.tools
				: null,
		}));
}

function oneLine(value: string, max: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/** Compact text block listing discovered profiles for the tool description. */
export function formatAgentCatalogText(agents: AgentDefinition[]): string {
	const ordered = agents
		.slice()
		.sort((left, right) => left.displayName.localeCompare(right.displayName));
	if (ordered.length === 0) {
		return 'No named subagent profiles are configured. Omit "agent" to run an unnamed general-purpose worker.';
	}
	const lines: string[] = [];
	for (const agent of ordered) {
		const parts: string[] = [`- ${agent.displayName}`];
		if (agent.description !== undefined) {
			parts.push(`— ${oneLine(agent.description, MAX_ENTRY_DESCRIPTION)}`);
		}
		const meta: string[] = [];
		if (agent.backend !== undefined) meta.push(`backend ${agent.backend}`);
		if (agent.model !== undefined) meta.push(`model ${agent.model}`);
		if (agent.thinking !== undefined) meta.push(`thinking ${agent.thinking}`);
		if (agent.tools !== undefined && agent.tools.length > 0)
			meta.push(`tools: ${agent.tools.join(",")}`);
		meta.push(agent.source === "project" ? "project" : "global");
		if (meta.length > 0) parts.push(`(${meta.join(" · ")})`);
		lines.push(parts.join(" "));
		const candidate = `Available named subagent profiles (set "agent" to one of these):\n${lines.join("\n")}`;
		if (candidate.length > MAX_CATALOG_CHARS) {
			lines.pop();
			break;
		}
	}
	const hidden = ordered.length - lines.length;
	const footer = hidden > 0
		? `\n… plus ${hidden} more profile(s); use action:"agents" for the full list.`
		: "";
	return `Available named subagent profiles (set "agent" to one of these):\n${lines.join("\n")}${footer}`;
}
