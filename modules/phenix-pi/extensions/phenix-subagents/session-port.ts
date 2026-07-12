import type {
  AgentSessionExecutionBackend,
  AgentSessionId,
  AgentSessionNode,
  AgentSessionResult,
  AgentSessionStatus,
  AgentClientRef,
  ThinkingLevel,
  WorkflowExecutionBinding,
} from "../phenix-kernel/index.ts";
import { agentSessionId, agentClientRef } from "../phenix-kernel/index.ts";

import type { ContractArtifact } from "./contract.ts";
import type { MaterializedAgent } from "./contract-agent-materializer.ts";
import type {
  AsyncResultPayload,
  RuntimeChildResult,
  SpawnedChild,
  SubagentBackend,
} from "./backend.ts";

// ── Session execution parameters ────────────────────────────────────────────

export interface AgentSessionExecutionParams {
  readonly agent: string;
  readonly model?: string;
  readonly thinking: string;
  readonly cwd: string;
  readonly maxTurns: number;
  readonly graceTurns: number;
  readonly toolSoft: number;
  readonly toolHard: number;
  readonly toolBlock: readonly string[];
  readonly maxSubagentDepth: number;
  readonly timeoutMs: number;
  readonly async: boolean;
  readonly clarify: boolean;
}

// ── Create / resume requests ─────────────────────────────────────────────────

export interface CreateAgentSessionRequest {
  readonly requestId: string;
  readonly agentClient?: AgentClientRef;
  readonly contract: ContractArtifact;
  readonly materializedAgent: MaterializedAgent;
  readonly environment: Readonly<Record<string, string>>;
  readonly params: AgentSessionExecutionParams;
  readonly parentId?: AgentSessionId;
  readonly rootId?: AgentSessionId;
  readonly workflowBinding?: WorkflowExecutionBinding;
}

export interface ResumeAgentSessionInput {
  readonly awaitCompletion?: boolean;
}

// ── Runtime-augmented result ────────────────────────────────────────────────

export type RuntimeAgentSessionResult = AgentSessionResult & {
  readonly payload?: AsyncResultPayload;
  readonly children?: readonly RuntimeChildResult[];
};

// ── Phenix-owned session execution port ─────────────────────────────────────
//
// The rest of Phenix depends only on this port. It is framed around session
// creation and continuation rather than a single opaque execute() call. The
// initial adapter (PiSubagentsAgentSessionPort) translates this abstraction to
// the package-specific spawn/result-poll/interrupt operations; an in-process
// Pi session runner can implement the same port later without touching the
// coordinator or attempt runner.

export interface AgentSessionPort {
  create(
    request: CreateAgentSessionRequest,
    signal: AbortSignal,
  ): Promise<AgentSessionNode>;

  run(
    sessionId: AgentSessionId,
    signal: AbortSignal,
  ): Promise<RuntimeAgentSessionResult>;

  resume(
    sessionId: AgentSessionId,
    input?: ResumeAgentSessionInput,
    signal?: AbortSignal,
  ): Promise<RuntimeAgentSessionResult>;

  cancel(
    sessionId: AgentSessionId,
    reason: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

// ── Payload → result mapping ────────────────────────────────────────────────

function statusFromPayload(payload: AsyncResultPayload): AgentSessionStatus {
  if (payload.success === true || payload.state === "completed") return "completed";
  if (payload.state === "cancelled") return "cancelled";
  if (payload.success === false || payload.error) return "failed";
  return "waiting";
}

function resultFromPayload(
  sessionId: AgentSessionId,
  payload: AsyncResultPayload,
  children: readonly RuntimeChildResult[],
): RuntimeAgentSessionResult {
  const status = statusFromPayload(payload);

  if (status === "completed") {
    return {
      status: "completed",
      sessionId,
      output: payload,
      payload,
      children,
    };
  }

  if (status === "cancelled") {
    return {
      status: "cancelled",
      sessionId,
      reason: payload.error ?? "cancelled",
      payload,
      children,
    };
  }

  if (status === "failed") {
    return {
      status: "failed",
      sessionId,
      code: "SESSION_FAILED",
      message:
        payload.error ??
        `agent session ended in state ${payload.state ?? "unknown"}`,
      payload,
      children,
    };
  }

  return {
    status: "waiting",
    sessionId,
    payload,
    children,
  };
}

// ── pi-subagents compatibility adapter ──────────────────────────────────────

interface StoredSession {
  readonly node: AgentSessionNode;
  readonly spawned: SpawnedChild;
}

/**
 * Compatibility adapter from the Phenix-owned AgentSessionPort to the current
 * pi-subagents process runner.
 *
 * This is the only place that translates the session abstraction to the
 * package-specific spawn, result polling, interrupt, and stop operations. When
 * a real in-process Pi session API exists, a new AgentSessionPort
 * implementation can replace this adapter without changing its callers.
 */
export class PiSubagentsAgentSessionPort implements AgentSessionPort {
  private readonly sessions = new Map<AgentSessionId, StoredSession>();
  private readonly executionBackend: AgentSessionExecutionBackend;

  constructor(
    private readonly backend: SubagentBackend,
    executionBackend: AgentSessionExecutionBackend = "external-process",
  ) {
    this.executionBackend = executionBackend;
  }

  async create(
    request: CreateAgentSessionRequest,
    signal: AbortSignal,
  ): Promise<AgentSessionNode> {
    const spawned = await this.backend.spawn(
      {
        requestId: request.requestId,
        params: request.params,
        environment: request.environment,
        extraAgentDirectory: request.materializedAgent.leaseDir,
      },
      signal,
    );

    const id = agentSessionId(spawned.runId);
    const rootId = request.rootId ?? request.parentId ?? id;
    const artifact = request.contract;
    const agentClient =
      request.agentClient ?? agentClientRef(artifact.identity.role ?? "base");

    const node: AgentSessionNode = {
      id,
      ...(request.parentId ? { parentId: request.parentId } : {}),
      rootId,
      agentClient,
      ...(artifact.runtime.model ? { model: artifact.runtime.model } : {}),
      thinking: artifact.runtime.thinking as ThinkingLevel,
      contract: {
        contractId: artifact.id,
        runId: artifact.identity.runId,
        role: artifact.identity.role,
      },
      ...(request.workflowBinding
        ? { workflowBinding: request.workflowBinding }
        : {}),
      context: {
        cwd: artifact.runtime.cwd,
        executionBackend: this.executionBackend,
        // Execution-layer run id (the spawned agent run). The contract run id
        // is carried separately on node.contract.runId.
        runId: spawned.runId,
        asyncDir: spawned.asyncDir,
        backend: { timeoutMs: artifact.runtime.timeoutMs },
      },
      status: "running",
    };

    this.sessions.set(id, { node, spawned });
    return node;
  }

  async run(
    sessionId: AgentSessionId,
    signal: AbortSignal,
  ): Promise<RuntimeAgentSessionResult> {
    const session = this.requireSession(sessionId);
    const contractTimeout =
      (session.node.context.backend?.timeoutMs as number | undefined) ?? 0;
    const waitTimeout = contractTimeout + 30_000;
    const payload = await this.backend.waitForResult(
      session.spawned.runId,
      signal,
      waitTimeout,
    );
    const children = this.backend.asyncResultChildren(payload);
    return resultFromPayload(sessionId, payload, children);
  }
  async resume(
    sessionId: AgentSessionId,
    input: ResumeAgentSessionInput = {},
    signal: AbortSignal = new AbortController().signal,
  ): Promise<RuntimeAgentSessionResult> {
    if (input.awaitCompletion) return this.run(sessionId, signal);

    // Read the result file directly so polling works even if the session was
    // created by a previous process (the in-memory map is process-local).
    const runId = this.sessions.get(sessionId)?.spawned.runId ?? (sessionId as string);
    const payload = this.backend.readResult(runId);
    if (!payload) {
      return {
        status: "waiting",
        sessionId,
      };
    }

    const children = this.backend.asyncResultChildren(payload);
    return resultFromPayload(sessionId, payload, children);
  }

  async cancel(
    sessionId: AgentSessionId,
    _reason: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // Fall back to the session id as the run id for cross-process cancels.
    const runId = this.sessions.get(sessionId)?.spawned.runId ?? (sessionId as string);
    try {
      await this.backend.interrupt(runId, signal);
    } catch {
      await this.backend.stop(runId, signal).catch(() => undefined);
    }
  }

  /** Read a session node without running it. Used by inspect/tree tooling. */
  inspect(sessionId: AgentSessionId): AgentSessionNode | undefined {
    return this.sessions.get(sessionId)?.node;
  }

  private requireSession(sessionId: AgentSessionId): StoredSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`unknown Phenix agent session: ${sessionId}`);
    }
    return session;
  }
}
