import { join } from "node:path";
import {
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import {
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeEventBus,
} from "../extension/workspace-runtime-binding.ts";
import { HeadlessAuthCoordinator } from "./auth-coordinator.ts";
import { HeadlessExtensionUi } from "./extension-ui.ts";
import { createNeutralThemeAccess } from "./neutral-theme.ts";
import { createPiHeadlessExecutor } from "./pi-executor.ts";
import { HeadlessProtocolServer } from "./server.ts";
import { PiSessionEventBridge } from "./session-events.ts";
import { ObservableWorkspaceAccess } from "./workspace-access.ts";

export interface HeadlessPiHostOptions {
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly extensionPaths: readonly string[];
  readonly write: (line: string) => void | Promise<void>;
  readonly maxFrameBytes?: number;
}

export interface HeadlessPiHost {
  readonly server: HeadlessProtocolServer;
  readonly runtime: AgentSessionRuntime;
  readonly shutdownRequested: Promise<void>;
  rebind(): Promise<void>;
  dispose(): Promise<void>;
}

export async function createHeadlessPiHost(options: HeadlessPiHostOptions): Promise<HeadlessPiHost> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();
  const extensionPaths = [...options.extensionPaths];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: sessionCwd,
    agentDir: sessionAgentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir: sessionAgentDir,
      modelRuntime,
      resourceLoaderOptions: {
        additionalExtensionPaths: extensionPaths,
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd),
  });

  let server: HeadlessProtocolServer | undefined;
  const pendingEvents: unknown[] = [];
  const publish = async (event: unknown): Promise<void> => {
    if (!server) {
      pendingEvents.push(event);
      return;
    }
    await server.publish(event);
  };

  let requestShutdown: (() => void) | undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    requestShutdown = resolve;
  });
  let shutdownSignalled = false;
  const signalShutdown = (): void => {
    if (shutdownSignalled) return;
    shutdownSignalled = true;
    requestShutdown?.();
  };

  const workspace = new ObservableWorkspaceAccess();
  const themes = createNeutralThemeAccess();
  const extensionUi = new HeadlessExtensionUi({
    themes,
    publish: (event) => {
      void publish(event);
    },
  });
  const auth = new HeadlessAuthCoordinator({
    runtime: modelRuntime,
    publish: (event) => {
      void publish(event);
    },
  });
  const sessionEvents = new PiSessionEventBridge({
    runId: () => workspace.current()?.rootRunId,
    publish: (event) => publish(event),
  });

  const rebind = async (): Promise<void> => {
    workspace.replace(undefined);
    sessionEvents.bind(runtime.session);
    const extensionRuntime = runtime.services.resourceLoader.getExtensions().runtime;
    subscribeWorkspaceRuntime(extensionRuntime.events as WorkspaceRuntimeEventBus, (binding) => {
      workspace.replace(binding);
    });
    await runtime.session.bindExtensions({
      uiContext: extensionUi.context,
      mode: "rpc",
      abortHandler: () => {
        void runtime.session.abort();
      },
      shutdownHandler: signalShutdown,
      onError: (error) => {
        void publish({
          type: "extension.error",
          error: normalizeError(error),
        });
      },
    });
    for (const diagnostic of runtime.diagnostics) {
      await publish({
        type: "runtime.diagnostic",
        level: diagnostic.type,
        message: diagnostic.message,
      });
    }
  };

  runtime.setBeforeSessionInvalidate(() => {
    workspace.replace(undefined);
    sessionEvents.dispose();
    extensionUi.dispose();
  });
  runtime.setRebindSession(async () => rebind());

  const executor = createPiHeadlessExecutor({
    runtimeHost: runtime,
    workspace,
    auth,
    extensionUi,
    // AgentSessionRuntime invokes the canonical rebind hook after every
    // replacement, including replacements initiated from an extension. The
    // legacy adapter callback therefore intentionally does nothing.
    rebindSession: async () => undefined,
    publish,
    requestShutdown: signalShutdown,
  });
  server = new HeadlessProtocolServer({
    executor,
    write: options.write,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  });

  await rebind();
  for (const event of pendingEvents.splice(0)) {
    await server.publish(event);
  }

  let disposed = false;
  return {
    server,
    runtime,
    shutdownRequested,
    rebind,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      sessionEvents.dispose();
      workspace.replace(undefined);
      await server?.dispose();
    },
  };
}

function normalizeError(error: unknown): { readonly name: string; readonly message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
