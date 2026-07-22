import type {
  ChildRun,
  ChildSessionBackend,
  ChildSessionBackendKind,
  ChildSessionSpec,
} from "./child-session-types.ts";

/**
 * Transport-neutral supervisor boundary for a Pi execution runtime.
 *
 * SDK and RPC implementations must expose identical ChildRun semantics so the
 * execution authority never depends on Pi session construction details.
 */
export interface PiRuntimeAdapter extends ChildSessionBackend {
  readonly kind: ChildSessionBackendKind;
  supports(spec: ChildSessionSpec): boolean;
}

export class SelectingChildSessionBackend implements ChildSessionBackend {
  private readonly adapters: readonly PiRuntimeAdapter[];

  constructor(adapters: readonly PiRuntimeAdapter[]) {
    if (adapters.length === 0) throw new Error("At least one Pi runtime adapter is required.");
    this.adapters = [...adapters];
  }

  get kind(): ChildSessionBackendKind {
    const first = this.adapters[0];
    if (!first) throw new Error("Pi runtime adapter selection is empty.");
    return first.kind;
  }

  async start(spec: ChildSessionSpec, signal: AbortSignal): Promise<ChildRun> {
    const adapter = this.adapters.find((candidate) => candidate.supports(spec));
    if (!adapter) {
      throw new Error(
        `No Pi runtime adapter supports child ${spec.id} (${spec.model.provider}/${spec.model.id}).`,
      );
    }
    return adapter.start(spec, signal);
  }
}
