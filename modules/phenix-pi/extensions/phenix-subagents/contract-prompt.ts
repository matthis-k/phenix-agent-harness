import type {
  ContractArtifact,
} from "./contract.ts";

const CONTRACT_BLOCK_PATTERN =
  /<phenix-contract-runtime\b[^>]*>[\s\S]*?<\/phenix-contract-runtime>\s*/g;

export function stripContractRuntimeBlocks(
  text: string,
): string {
  return text.replace(
    CONTRACT_BLOCK_PATTERN,
    "",
  );
}

export function contractRuntimeBlock(
  contract: ContractArtifact,
): string {
  return [
    `<phenix-contract-runtime version="1" contract="${contract.id}">`,
    "You are executing a delegated Phenix contract.",
    "",
    `Contract ID: ${contract.id}`,
    "",
    "Before final completion:",
    `1. Call phenix_contract_get with id "${contract.id}" to retrieve the authoritative task, requirements, and output contract.`,
    "2. Complete only that contract.",
    `3. Call phenix_contract_submit with id "${contract.id}" and the complete JSON value required by the contract.`,
    "",
    "The submission tool validates the value before accepting it.",
    "If validation fails, correct the reported fields and submit again.",
    "Do not use prose as the completion handoff.",
    "Do not write contract files directly.",
    "Do not use contact_supervisor for routine completion.",
    "</phenix-contract-runtime>",
  ].join("\n");
}

export function injectContractRuntimeBlock(
  task: string,
  contract: ContractArtifact,
): string {
  const cleanTask =
    stripContractRuntimeBlocks(task);

  return [
    cleanTask.trim(),
    "",
    contractRuntimeBlock(contract),
  ].join("\n");
}
