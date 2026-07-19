/**
 * subagent-manager-factory — compose managers from authoritative compilers
 *
 * The factory owns stable runtime dependencies and one shared handle directory.
 * Callers supply a scoped compiler, so manager construction cannot bypass
 * workflow authority while all managers expose one coherent lifecycle view.
 */

import type { AcceptanceEngine, SubagentExecutionCompiler } from "./execution-plan.ts";
import type { SubagentSessionSpawner } from "./session-subagent-adapter.ts";
import { createSessionSubagentExecutionAdapter } from "./session-subagent-adapter.ts";
import {
  createSubagentManager,
  type SubagentHandle,
  SubagentHandleDirectory,
  type SubagentManager,
  type SubagentQuery,
  type SubagentSnapshot,
} from "./subagent-manager.ts";

export interface SubagentManagerFactory {
  create(compiler: SubagentExecutionCompiler): SubagentManager;
  get<TOutput = unknown>(id: string): SubagentHandle<TOutput> | undefined;
  list(query?: SubagentQuery): readonly SubagentSnapshot[];
  remove(id: string): void;
  readonly activeCount: number;
  shutdown(reason: string): Promise<void>;
}

export interface SessionSubagentManagerFactoryOptions {
  readonly sessions: SubagentSessionSpawner;
  readonly acceptance: AcceptanceEngine;
}

export class SessionSubagentManagerFactory implements SubagentManagerFactory {
  private readonly sessions: SubagentSessionSpawner;
  private readonly acceptance: AcceptanceEngine;
  private readonly directory = new SubagentHandleDirectory();

  constructor(options: SessionSubagentManagerFactoryOptions) {
    this.sessions = options.sessions;
    this.acceptance = options.acceptance;
  }

  create(compiler: SubagentExecutionCompiler): SubagentManager {
    return createSubagentManager(
      createSessionSubagentExecutionAdapter({
        compiler,
        acceptance: this.acceptance,
        sessions: this.sessions,
      }),
      this.directory,
    );
  }

  get<TOutput = unknown>(id: string): SubagentHandle<TOutput> | undefined {
    return this.directory.get<TOutput>(id);
  }

  list(query?: SubagentQuery): readonly SubagentSnapshot[] {
    return this.directory.list(query);
  }

  remove(id: string): void {
    this.directory.remove(id);
  }

  get activeCount(): number {
    return this.directory.size;
  }

  shutdown(reason: string): Promise<void> {
    return this.directory.shutdown(reason);
  }
}

export function createSessionSubagentManagerFactory(
  options: SessionSubagentManagerFactoryOptions,
): SessionSubagentManagerFactory {
  return new SessionSubagentManagerFactory(options);
}
