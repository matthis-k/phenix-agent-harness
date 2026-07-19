import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ContractDefinition } from "@matthis-k/phenix-contracts/definitions.ts";
import type { WorkflowDefinition } from "@matthis-k/phenix-flow/workflow-types.ts";
import { modelSetRef } from "@matthis-k/phenix-kernel/refs.ts";
import type { RoutingConfiguration } from "@matthis-k/phenix-routing/definitions.ts";
import type { PhenixConfiguration } from "./composition/configuration.ts";
import { DEFAULT_MAXIMUM_DELEGATION_DEPTH } from "./composition/runtime-policy.ts";
import { defaultAgentClients } from "./defaults/agents.ts";
import { defaultContracts } from "./defaults/contracts.ts";
import { defaultAgentRoutes, defaultModelPools, defaultModelSets } from "./defaults/routing.ts";
import { PHENIX_DEFAULT_WORKFLOW } from "./defaults/workflow.ts";
import type { AgentClientDefinition } from "./subagents/definitions.ts";

export interface PhenixSuiteConfiguration {
  readonly composition: PhenixConfiguration;
  readonly workflows: readonly WorkflowDefinition[];
  readonly activeWorkflowDefinitionId: string;
}

interface SuiteSettingsFile {
  readonly activeModelSet?: string;
  readonly activeWorkflow?: string;
  readonly runtime?: {
    readonly maximumDelegationDepth?: number;
    readonly persistChildSessions?: boolean;
  };
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function readJson<T>(candidate: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(candidate, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function configPath(name: string): string {
  return path.join(getAgentDir(), "phenix", name);
}

function readArray<T>(name: string, fallback: readonly T[]): readonly T[] {
  const value = readJson<unknown>(configPath(name));
  return Array.isArray(value) ? (value as readonly T[]) : fallback;
}

function readRouting(fallback: RoutingConfiguration): RoutingConfiguration {
  return readJson<RoutingConfiguration>(configPath("routing.json")) ?? fallback;
}

function readWorkflows(): readonly WorkflowDefinition[] {
  const value = readJson<unknown>(configPath("workflow.json"));
  if (!value) return [PHENIX_DEFAULT_WORKFLOW];
  return Array.isArray(value)
    ? (value as readonly WorkflowDefinition[])
    : [value as WorkflowDefinition];
}

export function loadPhenixSuiteConfiguration(): PhenixSuiteConfiguration {
  const settings = readJson<SuiteSettingsFile>(configPath("settings.json")) ?? {};
  const contracts = readArray<ContractDefinition>("contracts.json", defaultContracts);
  const agentClients = readArray<AgentClientDefinition>("agents.json", defaultAgentClients);
  const routing = readRouting({
    modelSets: defaultModelSets,
    pools: defaultModelPools,
    agentRoutes: defaultAgentRoutes,
  });
  const workflows = readWorkflows();
  const activeWorkflowDefinitionId =
    settings.activeWorkflow ?? workflows[0]?.id ?? "phenix-default";

  return {
    workflows,
    activeWorkflowDefinitionId,
    composition: {
      activeModelSet: modelSetRef(settings.activeModelSet ?? "mixed"),
      contracts,
      agentClients,
      routing,
      runtime: {
        maximumDelegationDepth:
          settings.runtime?.maximumDelegationDepth ?? DEFAULT_MAXIMUM_DELEGATION_DEPTH,
        persistChildSessions: settings.runtime?.persistChildSessions ?? true,
      },
    },
  };
}
