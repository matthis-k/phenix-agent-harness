import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTaskClientTools } from "@matthis-k/phenix-tasks/pi-tools.ts";
import { taskClientFromEnvironment } from "@matthis-k/phenix-tasks/transport.ts";

import { FileContractStore } from "../subagents/contract-store.ts";
import type { ContractId } from "../subagents/contract.ts";
import { resolveChildExtensionFactories } from "./child-session-resources.ts";
import { createCompletionTool } from "./completion-tool.ts";
import { ContractSubmissionChannelImpl } from "./contract-channel.ts";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Isolated Phenix child requires ${name}.`);
  return value;
}

function stringArrayEnvironment(name: string): readonly string[] {
  const value = process.env[name]?.trim();
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON string array.`);
  }
  return parsed;
}

/** Exact bootstrap extension loaded into one isolated Pi RPC child. */
export default async function rpcChildExtension(pi: ExtensionAPI): Promise<void> {
  const contractRoot = requiredEnvironment("PHENIX_RPC_CONTRACT_ROOT");
  const contractId = requiredEnvironment("PHENIX_RPC_CONTRACT_ID") as ContractId;
  const store = new FileContractStore(contractRoot);
  const persisted = await store.load(contractId);
  if (!persisted) throw new Error(`Isolated Phenix contract not found: ${contractId}`);

  const extensionRefs = stringArrayEnvironment("PHENIX_RPC_EXTENSION_REFS");
  for (const factory of await resolveChildExtensionFactories(extensionRefs)) {
    await factory(pi);
  }

  const channel = new ContractSubmissionChannelImpl(store, persisted.artifact);
  pi.registerTool(createCompletionTool(channel) as never);

  const taskClient = taskClientFromEnvironment();
  if (taskClient) {
    for (const tool of createTaskClientTools({ resolveClient: () => taskClient })) {
      pi.registerTool(tool as never);
    }
  }

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: [
      event.systemPrompt,
      "",
      "## Isolated Phenix Assignment",
      `Contract: ${persisted.artifact.id}`,
      `Role: ${persisted.artifact.identity.role ?? "base"}`,
      "Work only on the supplied assignment and capability-scoped task subtree.",
      "Submit the final structured result through phenix_complete. Runtime exit alone is not completion.",
      "This isolated worker cannot create nested children.",
    ].join("\n"),
  }));
}
