/**
 * subagent-manager-factory — compose managers from authoritative compilers
 *
 * The factory owns stable runtime dependencies. Callers must supply a scoped
 * compiler, so constructing a manager never bypasses workflow authority.
 */

import type { AcceptanceEngine, SubagentExecutionCompiler } from "./execution-plan.ts";
import type { SubagentSessionSpawner } from "./session-subagent-adapter.ts";
import { createSessionSubagentExecutionAdapter } from "./session-subagent-adapter.ts";
import { createSubagentManager, type SubagentManager } from "./subagent-manager.ts";

export interface SubagentManagerFactory {
  create(compiler: SubagentExecutionCompiler): SubagentManager;
}

export interface SessionSubagentManagerFactoryOptions {
  readonly sessions: SubagentSessionSpawner;
  readonly acceptance: AcceptanceEngine;
}

export class SessionSubagentManagerFactory implements SubagentManagerFactory {
  private readonly sessions: SubagentSessionSpawner;
  private readonly acceptance: AcceptanceEngine;

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
    );
  }
}

export function createSessionSubagentManagerFactory(
  options: SessionSubagentManagerFactoryOptions,
): SessionSubagentManagerFactory {
  return new SessionSubagentManagerFactory(options);
}
