/**
 * phenix-skill-bootstrap — Phenix subagents skill prompt bootstrap
 *
 * Extracted from phenix.ts so tests can verify skill bootstrap without
 * importing the full Pi SDK runtime chain.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PHENIX_PROVIDER } from "./phenix-routing/provider.ts";

// ── Phenix coding substrate skill ───────────────────────────────────────────

const PHENIX_SUBAGENTS_SKILL_NAME = "phenix-subagents";

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown.trim();
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return markdown.trim();
  return markdown.slice(end + "\n---\n".length).trim();
}

function phenixSubagentsSkillBlock(): string {
  const skillDirectory = fileURLToPath(
    new URL("../skills/phenix-subagents", import.meta.url),
  );
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
  model: { readonly provider?: string } | null | undefined,
): boolean {
  return model?.provider === PHENIX_PROVIDER;
}

export function bootstrapPhenixSubagentsSkillPrompt(systemPrompt: string): string {
  if (systemPrompt.includes(`<skill name="${PHENIX_SUBAGENTS_SKILL_NAME}"`)) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n${phenixSubagentsSkillBlock()}`;
}
