import path from "node:path";

import { findProjectRoot } from "../subagents/handle-store.ts";
import { createExecutionAuthority } from "./factory.ts";
import type { ExecutionAuthority } from "./service.ts";
import { FileExecutionAuthorityStore } from "./store.ts";

const authorities = new Map<string, ExecutionAuthority>();

export function executionAuthorityForProject(cwd: string): ExecutionAuthority {
  const root = findProjectRoot(cwd);
  const existing = authorities.get(root);
  if (existing) return existing;
  const authority = createExecutionAuthority({
    store: new FileExecutionAuthorityStore(
      path.join(root, ".phenix-agent-state", "authority", "execution.json"),
    ),
  });
  authorities.set(root, authority);
  return authority;
}

export function clearExecutionAuthorityRegistry(): void {
  authorities.clear();
}

export function registeredExecutionAuthorities(): readonly ExecutionAuthority[] {
  return [...authorities.values()];
}
