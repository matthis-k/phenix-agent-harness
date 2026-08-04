import { randomUUID } from "node:crypto";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { HeadlessAuthMethod, HeadlessAuthResponse } from "./protocol.ts";

export interface HeadlessAuthProviderSummary {
  readonly id: string;
  readonly displayName: string;
  readonly methods: readonly HeadlessAuthMethod[];
  readonly configured: boolean;
  readonly source?: string;
}

export type HeadlessAuthPrompt =
  | { readonly kind: "text"; readonly message: string; readonly placeholder?: string }
  | { readonly kind: "secret"; readonly message: string; readonly placeholder?: string }
  | {
      readonly kind: "select";
      readonly message: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
      }[];
    }
  | { readonly kind: "manual_code"; readonly message: string; readonly placeholder?: string };

export type HeadlessAuthNotice =
  | {
      readonly kind: "information";
      readonly message: string;
      readonly links: readonly { readonly url: string; readonly label?: string }[];
    }
  | { readonly kind: "url"; readonly url: string; readonly instructions?: string }
  | {
      readonly kind: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | { readonly kind: "progress"; readonly message: string };

export type HeadlessAuthEvent =
  | {
      readonly type: "auth.prompt.requested";
      readonly flowId: string;
      readonly prompt: HeadlessAuthPrompt;
    }
  | { readonly type: "auth.prompt.cancelled"; readonly flowId: string }
  | {
      readonly type: "auth.notice";
      readonly flowId: string;
      readonly notice: HeadlessAuthNotice;
    }
  | {
      readonly type: "auth.finished";
      readonly flowId: string;
      readonly providerId: string;
      readonly result:
        | { readonly kind: "succeeded" }
        | { readonly kind: "cancelled" }
        | { readonly kind: "failed"; readonly message: string };
    };

type AuthRuntime = Pick<
  ModelRuntime,
  "getProviders" | "getProviderAuthStatus" | "login" | "logout"
>;

interface PendingPrompt {
  readonly prompt: AuthPrompt;
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

interface AuthFlow {
  readonly id: string;
  readonly providerId: string;
  readonly controller: AbortController;
  pending?: PendingPrompt;
}

export class HeadlessAuthCoordinator {
  readonly #runtime: AuthRuntime;
  readonly #publish: (event: HeadlessAuthEvent) => void;
  readonly #createId: () => string;
  readonly #flows = new Map<string, AuthFlow>();
  readonly #providerFlows = new Map<string, string>();

  constructor(input: {
    readonly runtime: AuthRuntime;
    readonly publish: (event: HeadlessAuthEvent) => void;
    readonly createId?: () => string;
  }) {
    this.#runtime = input.runtime;
    this.#publish = input.publish;
    this.#createId = input.createId ?? randomUUID;
  }

  listProviders(): readonly HeadlessAuthProviderSummary[] {
    return this.#runtime.getProviders().flatMap((provider) => {
      const methods: HeadlessAuthMethod[] = [];
      if (provider.auth.oauth) methods.push("oauth");
      if (provider.auth.apiKey?.login) methods.push("api_key");
      if (methods.length === 0) return [];
      const status = this.#runtime.getProviderAuthStatus(provider.id);
      return [
        {
          id: provider.id,
          displayName: provider.name,
          methods,
          configured: status.configured,
          ...(status.label ? { source: status.label } : {}),
        },
      ];
    });
  }

  start(providerId: string, method: HeadlessAuthMethod): string {
    if (this.#providerFlows.has(providerId)) {
      throw new Error(`Authentication is already active for provider ${providerId}`);
    }
    const provider = this.#runtime.getProviders().find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    if (method === "oauth" && !provider.auth.oauth) {
      throw new Error(`Provider ${providerId} does not support OAuth login`);
    }
    if (method === "api_key" && !provider.auth.apiKey?.login) {
      throw new Error(`Provider ${providerId} does not support interactive API-key setup`);
    }

    const id = this.#createId();
    const flow: AuthFlow = {
      id,
      providerId,
      controller: new AbortController(),
    };
    this.#flows.set(id, flow);
    this.#providerFlows.set(providerId, id);
    void this.runFlow(flow, method);
    return id;
  }

  respond(flowId: string, response: HeadlessAuthResponse): void {
    const flow = this.requireFlow(flowId);
    const pending = flow.pending;
    if (!pending) throw new Error(`Authentication flow ${flowId} is not awaiting input`);

    if (response.kind === "cancelled") {
      pending.reject(abortError(`Authentication prompt cancelled`));
      return;
    }

    const value = responseValue(pending.prompt, response);
    pending.resolve(value);
  }

  cancel(flowId: string): void {
    this.requireFlow(flowId).controller.abort();
  }

  async logout(providerId: string): Promise<void> {
    const activeFlow = this.#providerFlows.get(providerId);
    if (activeFlow) this.cancel(activeFlow);
    await this.#runtime.logout(providerId);
  }

  dispose(): void {
    for (const flow of this.#flows.values()) flow.controller.abort();
  }

  private requireFlow(flowId: string): AuthFlow {
    const flow = this.#flows.get(flowId);
    if (!flow) throw new Error(`Unknown authentication flow: ${flowId}`);
    return flow;
  }

  private async runFlow(flow: AuthFlow, method: HeadlessAuthMethod): Promise<void> {
    const interaction: AuthInteraction = {
      signal: flow.controller.signal,
      prompt: (prompt) => this.requestPrompt(flow, prompt),
      notify: (event) => {
        this.#publish({
          type: "auth.notice",
          flowId: flow.id,
          notice: authNotice(event),
        });
      },
    };

    try {
      await this.#runtime.login(flow.providerId, authType(method), interaction);
      this.#publish({
        type: "auth.finished",
        flowId: flow.id,
        providerId: flow.providerId,
        result: { kind: "succeeded" },
      });
    } catch (error: unknown) {
      this.#publish({
        type: "auth.finished",
        flowId: flow.id,
        providerId: flow.providerId,
        result: flow.controller.signal.aborted
          ? { kind: "cancelled" }
          : {
              kind: "failed",
              message: error instanceof Error ? error.message : String(error),
            },
      });
    } finally {
      flow.pending?.cleanup();
      this.#flows.delete(flow.id);
      this.#providerFlows.delete(flow.providerId);
    }
  }

  private requestPrompt(flow: AuthFlow, prompt: AuthPrompt): Promise<string> {
    if (flow.pending) {
      return Promise.reject(new Error(`Authentication flow ${flow.id} already has a pending prompt`));
    }
    if (flow.controller.signal.aborted || prompt.signal?.aborted) {
      return Promise.reject(abortError(`Authentication flow cancelled`));
    }

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onFlowAbort = (): void => settle(() => reject(abortError(`Authentication flow cancelled`)));
      const onPromptAbort = (): void => {
        this.#publish({ type: "auth.prompt.cancelled", flowId: flow.id });
        settle(() => reject(abortError(`Authentication prompt cancelled`)));
      };
      const cleanup = (): void => {
        flow.controller.signal.removeEventListener("abort", onFlowAbort);
        prompt.signal?.removeEventListener("abort", onPromptAbort);
        if (flow.pending?.prompt === prompt) flow.pending = undefined;
      };

      flow.controller.signal.addEventListener("abort", onFlowAbort, { once: true });
      prompt.signal?.addEventListener("abort", onPromptAbort, { once: true });
      flow.pending = {
        prompt,
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
        cleanup,
      };
      this.#publish({
        type: "auth.prompt.requested",
        flowId: flow.id,
        prompt: authPrompt(prompt),
      });
    });
  }
}

function authType(method: HeadlessAuthMethod): AuthType {
  return method === "oauth" ? "oauth" : "api_key";
}

function authPrompt(prompt: AuthPrompt): HeadlessAuthPrompt {
  switch (prompt.type) {
    case "text":
      return {
        kind: "text",
        message: prompt.message,
        ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
      };
    case "secret":
      return {
        kind: "secret",
        message: prompt.message,
        ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
      };
    case "select":
      return {
        kind: "select",
        message: prompt.message,
        options: prompt.options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
      };
    case "manual_code":
      return {
        kind: "manual_code",
        message: prompt.message,
        ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
      };
  }
}

function authNotice(event: AuthEvent): HeadlessAuthNotice {
  switch (event.type) {
    case "info":
      return {
        kind: "information",
        message: event.message,
        links: (event.links ?? []).map((link) => ({
          url: link.url,
          ...(link.label ? { label: link.label } : {}),
        })),
      };
    case "auth_url":
      return {
        kind: "url",
        url: event.url,
        ...(event.instructions ? { instructions: event.instructions } : {}),
      };
    case "device_code":
      return {
        kind: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.intervalSeconds !== undefined
          ? { intervalSeconds: event.intervalSeconds }
          : {}),
        ...(event.expiresInSeconds !== undefined
          ? { expiresInSeconds: event.expiresInSeconds }
          : {}),
      };
    case "progress":
      return { kind: "progress", message: event.message };
  }
}

function responseValue(prompt: AuthPrompt, response: Exclude<HeadlessAuthResponse, { kind: "cancelled" }>): string {
  switch (prompt.type) {
    case "text":
      if (response.kind === "text") return response.value;
      break;
    case "secret":
      if (response.kind === "secret") return response.value;
      break;
    case "select":
      if (response.kind === "selected") return response.value;
      break;
    case "manual_code":
      if (response.kind === "manual_code") return response.value;
      break;
  }
  throw new Error(`Authentication response ${response.kind} does not match prompt ${prompt.type}`);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
