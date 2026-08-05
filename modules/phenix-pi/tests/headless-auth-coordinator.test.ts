import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInteraction, Credential, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { HeadlessAuthCoordinator, type HeadlessAuthEvent } from "../headless/auth-coordinator.ts";

type AuthRuntime = Pick<
  ModelRuntime,
  "getProviders" | "getProviderAuthStatus" | "login" | "logout"
>;

test("headless auth translates a secret prompt and returns the native response", async () => {
  const events: HeadlessAuthEvent[] = [];
  let interaction: AuthInteraction | undefined;
  let receivedSecret: string | undefined;
  const runtime = fakeRuntime({
    login: async (_providerId, _type, currentInteraction) => {
      interaction = currentInteraction;
      receivedSecret = await currentInteraction.prompt({
        type: "secret",
        message: "API key",
        placeholder: "key-...",
      });
      return { type: "api_key", key: receivedSecret };
    },
  });
  const coordinator = new HeadlessAuthCoordinator({
    runtime,
    publish: (event) => events.push(event),
    createId: () => "flow-1",
  });

  const flowId = coordinator.start("example", "api_key");
  await nextTurn();
  assert.equal(flowId, "flow-1");
  assert.deepEqual(events[0], {
    type: "auth.prompt.requested",
    flowId: "flow-1",
    prompt: { kind: "secret", message: "API key", placeholder: "key-..." },
  });

  coordinator.respond(flowId, { kind: "secret", value: "secret-value" });
  await nextTurn();
  assert.equal(receivedSecret, "secret-value");
  assert.deepEqual(events.at(-1), {
    type: "auth.finished",
    flowId: "flow-1",
    providerId: "example",
    result: { kind: "succeeded" },
  });
  assert.ok(interaction);
});

test("prompt-local abort is propagated without cancelling the complete coordinator", async () => {
  const events: HeadlessAuthEvent[] = [];
  const promptController = new AbortController();
  const runtime = fakeRuntime({
    login: async (_providerId, _type, interaction) => {
      await interaction.prompt({
        type: "manual_code",
        message: "Paste code",
        signal: promptController.signal,
      });
      return { type: "oauth", access: "a", refresh: "r", expires: 1 };
    },
  });
  const coordinator = new HeadlessAuthCoordinator({
    runtime,
    publish: (event) => events.push(event),
    createId: () => "flow-2",
  });

  coordinator.start("example", "oauth");
  await nextTurn();
  promptController.abort();
  await nextTurn();

  assert.ok(events.some((event) => event.type === "auth.prompt.cancelled"));
  assert.deepEqual(events.at(-1), {
    type: "auth.finished",
    flowId: "flow-2",
    providerId: "example",
    result: { kind: "failed", message: "Authentication prompt cancelled" },
  });
});

test("provider listing excludes ambient-only providers with no interactive setup", () => {
  const coordinator = new HeadlessAuthCoordinator({
    runtime: fakeRuntime({
      providers: [provider("example", true, true), provider("ambient", false, false)],
    }),
    publish: () => undefined,
  });

  assert.deepEqual(coordinator.listProviders(), [
    {
      id: "example",
      displayName: "Example",
      methods: ["oauth", "api_key"],
      configured: false,
    },
  ]);
});

function fakeRuntime(input: {
  readonly providers?: readonly Provider[];
  readonly login?: AuthRuntime["login"];
}): AuthRuntime {
  const providers = input.providers ?? [provider("example", true, true)];
  return {
    getProviders: () => providers,
    getProviderAuthStatus: () => ({ configured: false }),
    login: input.login ?? (async (): Promise<Credential> => ({ type: "api_key", key: "unused" })),
    logout: async () => undefined,
  };
}

function provider(id: string, oauth: boolean, apiKeyLogin: boolean): Provider {
  return {
    id,
    name: id === "example" ? "Example" : "Ambient",
    auth: {
      ...(oauth
        ? {
            oauth: {
              name: `${id} OAuth`,
              login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }),
              refresh: async (credential) => credential,
              toAuth: async (credential) => ({ apiKey: credential.access }),
            },
          }
        : {}),
      apiKey: {
        name: `${id} API key`,
        ...(apiKeyLogin
          ? {
              login: async () => ({ type: "api_key", key: "key" }),
            }
          : {}),
        resolve: async () => undefined,
      },
    },
    getModels: () => [],
    stream: () => {
      throw new Error("not used by auth tests");
    },
    streamSimple: () => {
      throw new Error("not used by auth tests");
    },
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
