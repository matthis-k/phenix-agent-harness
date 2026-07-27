import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  isPhenixModelSet,
  PHENIX_MODEL_SETS,
  type PiThinkingLevel,
  virtualModel,
} from "../../domain/definition/model.ts";
import type { SessionProfile } from "../../domain/run/model.ts";
import { registerFreeModelGuard } from "../pi-sdk/free-model-guard.ts";
import { PhenixModelResolver } from "./phenix-model-resolver.ts";
import { PiModelInventory } from "./pi-model-inventory.ts";

const PHENIX_PROVIDER = "phenix";
const PHENIX_API = "phenix-router" as Api;

type RouterStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface PhenixProviderDependencies {
  readonly modelRegistry: () => ModelRegistry | undefined;
  readonly profile: (sessionId: string) => Promise<SessionProfile>;
}

export function registerPhenixProvider(
  pi: ExtensionAPI,
  dependencies: PhenixProviderDependencies,
): void {
  registerFreeModelGuard(pi, dependencies.profile);
  pi.registerProvider(PHENIX_PROVIDER, {
    name: "Phenix",
    baseUrl: "https://phenix.invalid/router",
    // Pi requires a provider key even though this virtual provider never authenticates itself.
    apiKey: "unused-internal-provider-sentinel",
    authHeader: false,
    api: PHENIX_API,
    models: PHENIX_MODEL_SETS.map((modelSet) => ({
      id: modelSet,
      name: displayName(modelSet),
      api: PHENIX_API,
      reasoning: true,
      input: ["text", "image"] satisfies Model<Api>["input"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 32_768,
    })),
    streamSimple: createPhenixStream(dependencies),
  });
}

export function createPhenixStream(dependencies: PhenixProviderDependencies): RouterStream {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void route(output, model, context, options, dependencies).catch((error) => {
      output.push(terminalError(model.id, error instanceof Error ? error.message : String(error)));
      output.end();
    });
    return output;
  };
}

async function route(
  output: AssistantMessageEventStream,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  dependencies: PhenixProviderDependencies,
): Promise<void> {
  if (!isPhenixModelSet(model.id)) throw new Error(`Unknown Phenix model set: ${model.id}`);
  const registry = dependencies.modelRegistry();
  if (!registry) throw new Error(`Pi model registry is not available for routed execution`);

  const sessionId = options?.sessionId ?? "default";
  const profile = await dependencies.profile(sessionId);
  const resolved = await new PhenixModelResolver(new PiModelInventory(registry)).resolve(
    virtualModel(model.id),
    {
      definitionId: `agent.${profile.agent}`,
      parentDefinitionId: "root.session",
      thinking: "route",
      modelSet: model.id,
      difficulty: profile.difficulty,
    },
  );
  const concrete = registry.find(resolved.concrete.provider, resolved.concrete.model);
  if (!concrete) {
    throw new Error(
      `Configured model ${resolved.concrete.provider}/${resolved.concrete.model} is not registered`,
    );
  }
  const auth = await registry.getApiKeyAndHeaders(concrete);
  if (!auth.ok) throw new Error(`${concrete.provider}/${concrete.id}: ${auth.error}`);

  await forward(output, model.id, concrete, context, options, auth, resolved.thinking);
}

async function forward(
  output: AssistantMessageEventStream,
  virtualModelId: string,
  concrete: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  auth: {
    readonly apiKey?: string;
    readonly headers?: Record<string, string>;
    readonly env?: Record<string, string>;
  },
  thinking: PiThinkingLevel,
): Promise<void> {
  const { apiKey: _virtualApiKey, headers, env, ...rest } = options ?? {};
  const reasoning = thinking === "off" ? undefined : (thinking satisfies ThinkingLevel);
  const upstream = streamSimple(concrete, context, {
    ...rest,
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    headers: { ...headers, ...auth.headers },
    env: { ...env, ...auth.env },
    ...(reasoning ? { reasoning } : {}),
  });

  for await (const event of upstream) {
    output.push(maskEvent(event, virtualModelId));
    if (event.type === "done" || event.type === "error") {
      output.end();
      return;
    }
  }

  output.push(terminalError(virtualModelId, `Provider stream ended without a terminal event`));
  output.end();
}

function maskMessage(message: AssistantMessage, virtualModelId: string): AssistantMessage {
  return {
    ...message,
    api: PHENIX_API,
    provider: PHENIX_PROVIDER,
    model: virtualModelId,
  };
}

function maskEvent(event: AssistantMessageEvent, virtualModelId: string): AssistantMessageEvent {
  if (event.type === "done")
    return { ...event, message: maskMessage(event.message, virtualModelId) };
  if (event.type === "error") return { ...event, error: maskMessage(event.error, virtualModelId) };
  return { ...event, partial: maskMessage(event.partial, virtualModelId) };
}

function terminalError(virtualModelId: string, message: string): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: PHENIX_API,
      provider: PHENIX_PROVIDER,
      model: virtualModelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  };
}

function displayName(modelSet: string): string {
  if (modelSet === "chatgpt-plus") return "ChatGPT Plus";
  if (modelSet === "opencode-go") return "OpenCode Go";
  return modelSet[0]?.toUpperCase() + modelSet.slice(1);
}
