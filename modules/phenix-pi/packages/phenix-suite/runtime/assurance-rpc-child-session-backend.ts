import type { ChildSessionSpec } from "./child-session-types.ts";
import {
  RpcChildSessionBackend as ProcessRpcChildSessionBackend,
  type RpcChildSessionBackendOptions,
} from "./rpc-child-session-backend.ts";

function runtimePreference(): "sdk" | "rpc" | undefined {
  const value = process.env.PHENIX_CHILD_BACKEND?.trim().toLowerCase();
  return value === "sdk" || value === "rpc" ? value : undefined;
}

function isLeafAssignment(spec: ChildSessionSpec): boolean {
  return (
    spec.contract.runtime.delegation.remainingDepth <= 0 ||
    spec.contract.runtime.delegation.availableRoles.length === 0
  );
}

/**
 * Assurance-aware selector for the process-isolated Pi RPC transport.
 *
 * The transport implementation deliberately remains unaware of Phenix assurance
 * policy. This adapter selects it only for leaf assignments that explicitly
 * require isolation, or when the operator explicitly requests RPC.
 */
export class RpcChildSessionBackend extends ProcessRpcChildSessionBackend {
  constructor(options: RpcChildSessionBackendOptions) {
    super(options);
  }

  override supports(spec: ChildSessionSpec): boolean {
    const preference = runtimePreference();
    if (preference === "sdk") return false;
    if (!isLeafAssignment(spec)) return false;
    return preference === "rpc" || spec.isolationRequired === true;
  }
}

export type { RpcChildSessionBackendOptions };
