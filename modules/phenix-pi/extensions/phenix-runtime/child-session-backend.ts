/**
 * child-session-backend — backend selection and runtime-neutral boundary
 *
 * Keeps a runtime-neutral boundary so a Pi RpcClient process backend can
 * use the same orchestration as the SDK backend later.
 */

import type {
  ChildSessionBackend,
  ChildSessionBackendKind,
} from "./child-session-types.ts";
import {
  SdkChildSessionBackend,
} from "./sdk-child-session-backend.ts";
import {
  RpcChildSessionBackend,
} from "./rpc-child-session-backend.ts";
import type { PiRuntimeServices } from "./child-session-types.ts";

// ── Backend selection ───────────────────────────────────────────────────────

export interface ChildSessionBackendOptions {
  readonly kind: ChildSessionBackendKind;
  readonly services: PiRuntimeServices;
  readonly rpc?: {
    readonly cliPath?: string;
    readonly sessionDirectory?: string;
    readonly childExtensionPath?: string;
  };
  readonly buildCustomTools?: (spec: any) => readonly any[];
  readonly buildResourceLoader?: (spec: any, systemPrompt: string) => any;
  readonly buildSystemPrompt?: (spec: any) => string;
  readonly sessionFactory?: any;
  readonly clientFactory?: any;
}

/**
 * Construct the selected child-session backend.
 *
 * The SDK backend is the default and fully supported backend.
 * The RPC backend is a process-isolation adapter.
 */
export function createChildSessionBackend(
  options: ChildSessionBackendOptions,
): ChildSessionBackend {
  if (options.kind === "rpc") {
    return new RpcChildSessionBackend({
      rpc: options.rpc,
      ...(options.clientFactory ? { clientFactory: options.clientFactory } : {}),
    });
  }

  // Default: SDK backend
  return new SdkChildSessionBackend({
    services: options.services,
    ...(options.sessionFactory ? { sessionFactory: options.sessionFactory } : {}),
    ...(options.buildCustomTools ? { buildCustomTools: options.buildCustomTools } : {}),
    ...(options.buildResourceLoader ? { buildResourceLoader: options.buildResourceLoader } : {}),
    ...(options.buildSystemPrompt ? { buildSystemPrompt: options.buildSystemPrompt } : {}),
  });
}

// ── Re-exports ──────────────────────────────────────────────────────────────

export type {
  ChildSessionBackend,
  ChildSessionBackendKind,
  PiRuntimeServices,
} from "./child-session-types.ts";

export {
  SdkChildSessionBackend,
  ProductionPiSessionFactory,
  buildEffectiveToolNames,
} from "./sdk-child-session-backend.ts";
export type {
  PiSessionLike,
  PiSessionFactory,
  PreparedPiSessionSpec,
  PromptOptions,
  SdkChildSessionBackendOptions,
} from "./sdk-child-session-backend.ts";

export {
  RpcChildSessionBackend,
  ProductionRpcClientFactory,
} from "./rpc-child-session-backend.ts";
export type {
  RpcClientLike,
  RpcClientFactory,
  RpcChildSessionBackendOptions,
  RpcSessionStateLike,
} from "./rpc-child-session-backend.ts";
