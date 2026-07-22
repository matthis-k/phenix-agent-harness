import type {
  ChildRun,
  ChildSessionBackend,
  ChildSessionEvent,
  ChildSessionSpec,
} from "./child-session-types.ts";
import { ChildRuntimeError } from "./child-session-types.ts";

function timeoutError(spec: ChildSessionSpec): ChildRuntimeError {
  return new ChildRuntimeError(
    "TIMEOUT",
    `Child ${spec.id} exceeded its wall-clock budget of ${spec.timeoutMs}ms.`,
  );
}

/** Applies one wall-clock cancellation boundary to any Pi runtime adapter. */
export class TimedChildSessionBackend implements ChildSessionBackend {
  readonly kind: ChildSessionBackend["kind"];
  private readonly delegate: ChildSessionBackend;

  constructor(delegate: ChildSessionBackend) {
    this.delegate = delegate;
    this.kind = delegate.kind;
  }

  async start(spec: ChildSessionSpec, parentSignal: AbortSignal): Promise<ChildRun> {
    const controller = new AbortController();
    const abortFromParent = (): void => {
      if (!controller.signal.aborted) controller.abort(parentSignal.reason);
    };
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });

    let timeout: NodeJS.Timeout | undefined;
    if (spec.timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(timeoutError(spec));
      }, spec.timeoutMs);
      timeout.unref?.();
    }

    const clear = (): void => {
      parentSignal.removeEventListener("abort", abortFromParent);
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };

    let run: ChildRun;
    try {
      run = await this.delegate.start(spec, controller.signal);
    } catch (error) {
      clear();
      throw error;
    }

    const unsubscribe = run.subscribe((event: ChildSessionEvent) => {
      if (
        event.type === "session.failed" ||
        event.type === "session.cancelled" ||
        event.type === "session.disposed"
      ) {
        clear();
      }
    });

    return {
      id: run.id,
      backend: run.backend,
      get pi() {
        return run.pi;
      },
      snapshot: () => run.snapshot(),
      subscribe: (listener) => run.subscribe(listener),
      continue: (message, signal) => run.continue(message, signal),
      waitForCurrentCycle: (signal) => run.waitForCurrentCycle(signal),
      async abort(reason) {
        clear();
        unsubscribe();
        await run.abort(reason);
      },
      async dispose() {
        clear();
        unsubscribe();
        await run.dispose();
      },
    };
  }
}
