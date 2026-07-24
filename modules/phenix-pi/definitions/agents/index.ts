import { readFileSync } from "node:fs";

import { compileAgentMarkdown } from "../../adapters/agent/markdown.ts";
import type { AgentDefinition } from "../../domain/definition/definition.ts";
import { resolveDefinitionSchema } from "../schema-registry.ts";

function source(name: string): string {
  return readFileSync(new URL(`./sources/${name}.agent.md`, import.meta.url), "utf8");
}

function definition(name: string): AgentDefinition<unknown, unknown> {
  return compileAgentMarkdown(source(name), { resolveSchema: resolveDefinitionSchema });
}

export const scoutDefinition = definition("scout");
export const plannerDefinition = definition("planner");
export const architectDefinition = definition("architect");
export const implementerDefinition = definition("implementer");
export const testerDefinition = definition("tester");
export const verifierDefinition = definition("verifier");
export const criticDefinition = definition("critic");
export const finalizerDefinition = definition("finalizer");
export const dispatcherDefinition = definition("dispatcher");
export const coordinatorDefinition = definition("coordinator");
export const baseDefinition = definition("base");
export const qaSynthesizerDefinition = definition("qa-synthesizer");

export const agentDefinitions = [
  scoutDefinition,
  plannerDefinition,
  architectDefinition,
  implementerDefinition,
  testerDefinition,
  verifierDefinition,
  criticDefinition,
  finalizerDefinition,
  dispatcherDefinition,
  coordinatorDefinition,
  baseDefinition,
  qaSynthesizerDefinition,
] as const;
