import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AgentSessionEvent,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  type ChildSessionSpec,
  childRunId,
} from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
import {
  type PiSessionFactory,
  type PiSessionLike,
  type PreparedPiSessionSpec,
  SdkChildSessionBackend,
} from "@matthis-k/phenix-suite/runtime/sdk-child-session-backend.ts";

class RecordingSession implements PiSessionLike {
  readonly sessionId = "pi-child";
  readonly isStreaming = false;
  listener?: (event: AgentSessionEvent) => void;

  prompt(
    _text: string,
    options?: { readonly preflightResult?: (success: boolean) => void },
  ): Promise<void> {
    options?.preflightResult?.(true);
    return Promise.resolve();
  }

  followUp(): Promise<void> {
    return Promise.resolve();
  }

  steer(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}
}

class RecordingFactory implements PiSessionFactory {
  readonly session = new RecordingSession();
  spec?: PreparedPiSessionSpec;

  create(spec: PreparedPiSessionSpec): Promise<PiSessionLike> {
    this.spec = spec;
    return Promise.resolve(this.session);
  }
}

function childSpec(): ChildSessionSpec {
  return {
    id: childRunId("child-test"),
    rootId: childRunId("child-test"),
    handleId: "handle-test",
    agentClient: { kind: "agent-client", id: "scout" },
    role: "scout",
    cwd: "/tmp/child-test",
    model: { provider: "test-provider", id: "test-model" },
    thinkingLevel: "medium",
    initialPrompt: "Inspect the boundary.",
    contract: { id: "contract-test" },
    workflowProjection: { options: [] },
    contractChannel: {},
    parentContext: {},
    effectiveTools: [],
    skillRefs: [],
    extensionRefs: [],
    inheritProjectContext: true,
    timeoutMs: 1_000,
    turnBudget: {},
    toolBudget: {},
    persistence: "memory",
  } as unknown as ChildSessionSpec;
}

describe("SdkChildSessionBackend", () => {
  it("passes the captured root model runtime into the child Pi session", async () => {
    const concreteModel = { provider: "test-provider", id: "test-model" };
    const modelRuntime = {} as ModelRuntime;
    const registry = {
      getRegisteredProviderIds: () => [],
      getRegisteredProviderConfig: () => undefined,
      find(provider: string, id: string) {
        return provider === concreteModel.provider && id === concreteModel.id
          ? concreteModel
          : undefined;
      },
    } as unknown as ModelRegistry;
    const factory = new RecordingFactory();
    const backend = new SdkChildSessionBackend({
      services: { modelRegistry: registry, agentDir: "/tmp/agent" },
      sessionFactory: factory,
      createModelRuntime: async () => modelRuntime,
      buildSystemPrompt: () => "system",
      buildResourceLoader: () => ({}) as DefaultResourceLoader,
    });

    const run = await backend.start(childSpec(), new AbortController().signal);

    assert.equal(factory.spec?.modelRuntime, modelRuntime);
    assert.equal(factory.spec?.model, concreteModel);
    await run.dispose();
  });

  it("preserves provider diagnostics when Pi later rejects an accepted prompt", async () => {
    const registry = {
      getRegisteredProviderIds: () => [],
      getRegisteredProviderConfig: () => undefined,
      find() {
        return { provider: "test-provider", id: "test-model" };
      },
    } as unknown as ModelRegistry;
    const factory = new RecordingFactory();
    factory.session.prompt = (_text, options) => {
      options?.preflightResult?.(true);
      return new Promise<void>((_resolve, reject) => {
        queueMicrotask(() => {
          factory.session.listener?.({
            type: "error",
            errorMessage: "No API key for provider: test-provider",
          } as unknown as AgentSessionEvent);
          reject(new Error("Operation aborted"));
        });
      });
    };
    const backend = new SdkChildSessionBackend({
      services: { modelRegistry: registry, agentDir: "/tmp/agent" },
      sessionFactory: factory,
      createModelRuntime: async () => ({}) as ModelRuntime,
      buildSystemPrompt: () => "system",
      buildResourceLoader: () => ({}) as DefaultResourceLoader,
    });

    const run = await backend.start(childSpec(), new AbortController().signal);
    const outcome = await run.waitForCurrentCycle();

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.code, "PROVIDER_FAILED");
    assert.equal(outcome.error?.message, "No API key for provider: test-provider");
    await run.dispose();
  });
});
