/**
 * phenix-skill-bootstrap — scoped Phenix root-model prompt contribution
 *
 * The skill and coding-substrate guidance are injected as one contribution so
 * direct non-Phenix models never receive Phenix workflow instructions.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelIdentity } from "./phenix-composition/model-scope.ts";
import { phenixRootModelScope } from "./phenix-composition/model-scope.ts";

const PHENIX_SUBAGENTS_SKILL_NAME = "phenix-subagents";
const PHENIX_CODING_SUBSTRATE_HEADING = "## Phenix coding substrate";

const PHENIX_CODING_GUIDANCE = [
  "Use focused searches and bounded reads instead of dumping entire repositories or logs.",
  "Prefer LSP tools for diagnostics, types, symbols, definitions, and references when a matching server exists.",
  "Run LSP diagnostics on changed supported files before reporting completion.",
  "Use the `mcp` proxy to discover MCP capabilities on demand instead of assuming every MCP tool is directly registered.",
  "Use `web_search` for external discovery and `web_fetch` for specific pages; use `gh` through the shell for GitHub-native operations.",
  "Use `context_info` and compact only at coherent boundaries during genuinely long tasks.",
  "Use `phenix_workflow` for workflow operations. Call it with `action: inspect` for fresh authority and `action: delegate` with one returned actor-scoped agent name and a bounded task. Raw `subagent`, legacy `phenix_delegate`, and direct child-session configuration are runtime-blocked.",
  "Every delegated handoff must use a strict output schema. Invalid structured output is returned to the child with exact validation failures so it can repair the handoff.",
  "Runtime verification and critic gates are authoritative. Do not treat a model's claim that tests passed as verification evidence.",
  "The shell is intentionally permissive, but avoid destructive or unrelated operations unless the task requires them.",
] as const;

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown.trim();
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return markdown.trim();
  return markdown.slice(end + "\n---\n".length).trim();
}

function phenixSubagentsSkillBlock(): string {
  const skillDirectory = fileURLToPath(new URL("../skills/phenix-subagents", import.meta.url));
  const skillPath = path.join(skillDirectory, "SKILL.md");
  const skillBody = stripFrontmatter(fs.readFileSync(skillPath, "utf8"));

  return [
    `<skill name="${PHENIX_SUBAGENTS_SKILL_NAME}" location="${skillPath}">`,
    `References are relative to ${skillDirectory}.`,
    "",
    skillBody,
    "</skill>",
  ].join("\n");
}

export function shouldBootstrapPhenixSubagentsSkill(
  model: ModelIdentity | null | undefined,
): boolean {
  return phenixRootModelScope.includes(model);
}

export function bootstrapPhenixSubagentsSkillPrompt(systemPrompt: string): string {
  if (systemPrompt.includes(`<skill name="${PHENIX_SUBAGENTS_SKILL_NAME}"`)) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n${phenixSubagentsSkillBlock()}`;
}

/** Build the complete root prompt contribution, or nothing outside the scope. */
export function buildPhenixRootSystemPrompt(input: {
  readonly model: ModelIdentity | null | undefined;
  readonly systemPrompt: string;
}): string | undefined {
  if (!phenixRootModelScope.includes(input.model)) return undefined;

  const withSkill = bootstrapPhenixSubagentsSkillPrompt(input.systemPrompt);
  if (withSkill.includes(PHENIX_CODING_SUBSTRATE_HEADING)) return withSkill;

  const guidance = PHENIX_CODING_GUIDANCE.join("\n- ");
  return phenixRootModelScope.contributeSystemPrompt({
    model: input.model,
    systemPrompt: withSkill,
    contribution: `${PHENIX_CODING_SUBSTRATE_HEADING}\n\n- ${guidance}`,
  });
}
