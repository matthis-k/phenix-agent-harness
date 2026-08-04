import type { HeadlessCommand } from "./protocol.ts";
import type { HeadlessCommandExecutor } from "./server.ts";

type Command<T extends HeadlessCommand["type"]> = Extract<HeadlessCommand, { readonly type: T }>;

export interface HeadlessLifecyclePort {
  initialize(command: Command<"initialize">): Promise<unknown>;
  shutdown(): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface HeadlessExecutionPort {
  snapshot(): Promise<unknown>;
  submitPrompt(command: Command<"prompt.submit">): Promise<unknown>;
  steerPrompt(command: Command<"prompt.steer">): Promise<unknown>;
  followUpPrompt(command: Command<"prompt.follow_up">): Promise<unknown>;
  abort(command: Command<"execution.abort">): Promise<unknown>;
  startCompaction(command: Command<"compaction.start">): Promise<unknown>;
  abortCompaction(command: Command<"compaction.abort">): Promise<unknown>;
  configureRetry(command: Command<"retry.configure">): Promise<unknown>;
  abortRetry(command: Command<"retry.abort">): Promise<unknown>;
}

export interface HeadlessSessionPort {
  create(command: Command<"session.create">): Promise<unknown>;
  switch(command: Command<"session.switch">): Promise<unknown>;
  fork(command: Command<"session.fork">): Promise<unknown>;
  clone(command: Command<"session.clone">): Promise<unknown>;
  rename(command: Command<"session.rename">): Promise<unknown>;
  list(): Promise<unknown>;
  tree(command: Command<"session.tree">): Promise<unknown>;
  export(command: Command<"session.export">): Promise<unknown>;
}

export interface HeadlessModelPort {
  list(): Promise<unknown>;
  select(command: Command<"model.select">): Promise<unknown>;
  thinkingLevels(command: Command<"thinking.levels">): Promise<unknown>;
  selectThinking(command: Command<"thinking.select">): Promise<unknown>;
}

export interface HeadlessAuthPort {
  providers(): Promise<unknown>;
  start(command: Command<"auth.login.start">): Promise<unknown>;
  respond(command: Command<"auth.login.respond">): Promise<unknown>;
  cancel(command: Command<"auth.login.cancel">): Promise<unknown>;
  logout(command: Command<"auth.logout">): Promise<unknown>;
}

export interface HeadlessResourcePort {
  commands(): Promise<unknown>;
  invoke(command: Command<"command.invoke">): Promise<unknown>;
  reload(): Promise<unknown>;
}

export interface HeadlessExtensionUiPort {
  respond(command: Command<"extension_ui.respond">): Promise<unknown>;
}

export interface HeadlessExecutorDependencies {
  readonly lifecycle: HeadlessLifecyclePort;
  readonly execution: HeadlessExecutionPort;
  readonly sessions: HeadlessSessionPort;
  readonly models: HeadlessModelPort;
  readonly auth: HeadlessAuthPort;
  readonly resources: HeadlessResourcePort;
  readonly extensionUi: HeadlessExtensionUiPort;
}

export class HeadlessRuntimeExecutor implements HeadlessCommandExecutor {
  readonly #dependencies: HeadlessExecutorDependencies;
  #disposed = false;

  constructor(dependencies: HeadlessExecutorDependencies) {
    this.#dependencies = dependencies;
  }

  async execute(command: HeadlessCommand): Promise<unknown> {
    if (this.#disposed) throw new Error(`Headless runtime executor is disposed`);
    switch (command.type) {
      case "initialize":
        return this.#dependencies.lifecycle.initialize(command);
      case "snapshot.request":
        return this.#dependencies.execution.snapshot();
      case "prompt.submit":
        return this.#dependencies.execution.submitPrompt(command);
      case "prompt.steer":
        return this.#dependencies.execution.steerPrompt(command);
      case "prompt.follow_up":
        return this.#dependencies.execution.followUpPrompt(command);
      case "execution.abort":
        return this.#dependencies.execution.abort(command);
      case "session.create":
        return this.#dependencies.sessions.create(command);
      case "session.switch":
        return this.#dependencies.sessions.switch(command);
      case "session.fork":
        return this.#dependencies.sessions.fork(command);
      case "session.clone":
        return this.#dependencies.sessions.clone(command);
      case "session.rename":
        return this.#dependencies.sessions.rename(command);
      case "session.list":
        return this.#dependencies.sessions.list();
      case "session.tree":
        return this.#dependencies.sessions.tree(command);
      case "session.export":
        return this.#dependencies.sessions.export(command);
      case "model.list":
        return this.#dependencies.models.list();
      case "model.select":
        return this.#dependencies.models.select(command);
      case "thinking.levels":
        return this.#dependencies.models.thinkingLevels(command);
      case "thinking.select":
        return this.#dependencies.models.selectThinking(command);
      case "auth.providers":
        return this.#dependencies.auth.providers();
      case "auth.login.start":
        return this.#dependencies.auth.start(command);
      case "auth.login.respond":
        return this.#dependencies.auth.respond(command);
      case "auth.login.cancel":
        return this.#dependencies.auth.cancel(command);
      case "auth.logout":
        return this.#dependencies.auth.logout(command);
      case "compaction.start":
        return this.#dependencies.execution.startCompaction(command);
      case "compaction.abort":
        return this.#dependencies.execution.abortCompaction(command);
      case "retry.configure":
        return this.#dependencies.execution.configureRetry(command);
      case "retry.abort":
        return this.#dependencies.execution.abortRetry(command);
      case "command.list":
        return this.#dependencies.resources.commands();
      case "command.invoke":
        return this.#dependencies.resources.invoke(command);
      case "resource.reload":
        return this.#dependencies.resources.reload();
      case "extension_ui.respond":
        return this.#dependencies.extensionUi.respond(command);
      case "shutdown":
        return this.#dependencies.lifecycle.shutdown();
      default:
        return assertNever(command);
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#dependencies.lifecycle.dispose();
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled headless command: ${String(value)}`);
}
