import type {
  AgentSessionBackend,
  AgentSessionPort,
  AgentSessionReference,
  CreateAgentSessionSpec,
} from "../../ports/agent-session-backend.ts";
import type { RunId } from "../../domain/shared.ts";

export class AgentSessionBackendRouter implements AgentSessionBackend {
  private readonly backends: ReadonlyMap<string, AgentSessionBackend>;
  private readonly backendForRun: (runId: RunId) => string;

  constructor(input: {
    readonly backends: ReadonlyMap<string, AgentSessionBackend>;
    readonly backendForRun: (runId: RunId) => string;
  }) {
    if (input.backends.size === 0) {
      throw new Error("At least one agent-session backend must be registered");
    }
    for (const backendId of input.backends.keys()) {
      if (!backendId.trim()) throw new Error("Agent-session backend IDs must not be empty");
      if (backendId.includes("/")) {
        throw new Error(`Agent-session backend ID '${backendId}' must not contain '/'`);
      }
    }
    this.backends = new Map(input.backends);
    this.backendForRun = input.backendForRun;
  }

  create(spec: CreateAgentSessionSpec): Promise<AgentSessionPort> {
    return this.backend(spec.runId).create(spec);
  }

  recover(
    spec: CreateAgentSessionSpec,
    reference: AgentSessionReference,
  ): Promise<AgentSessionPort | undefined> {
    return this.backend(spec.runId).recover(spec, reference);
  }

  private backend(runId: RunId): AgentSessionBackend {
    const backendId = this.backendForRun(runId);
    const backend = this.backends.get(backendId);
    if (!backend) {
      throw new Error(
        `Run ${runId} targets unregistered agent-session backend '${backendId}'`,
      );
    }
    return backend;
  }
}
