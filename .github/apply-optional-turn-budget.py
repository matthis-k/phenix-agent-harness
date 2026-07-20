from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1))


replace(
    "modules/phenix-pi/packages/phenix-suite/subagents/agent-types.ts",
    '''export interface TurnBudget {
  readonly maxTurns: number;
  readonly graceTurns: number;
}
''',
    '''export interface TurnBudget {
  /** Optional hard cap. Omit it for open-ended work such as repository QA. */
  readonly maxTurns?: number;
  /** Additional turns allowed after an explicit hard cap. */
  readonly graceTurns?: number;
}
''',
)

policy = "modules/phenix-pi/packages/phenix-suite/subagents/policy.ts"
replace(
    policy,
    '''interface VerificationConfig {
  readonly maxRepairAttempts?: number;
  readonly timeoutMs?: number;
  readonly extraCommands?: readonly VerificationCommand[];
  readonly roleCommands?: Partial<Record<AgentKind, readonly VerificationCommand[]>>;
}

export interface RuntimePolicyConfig {
  readonly verification?: VerificationConfig;
}
''',
    '''interface VerificationConfig {
  readonly maxRepairAttempts?: number;
  readonly timeoutMs?: number;
  readonly extraCommands?: readonly VerificationCommand[];
  readonly roleCommands?: Partial<Record<AgentKind, readonly VerificationCommand[]>>;
}

interface ExecutionConfig {
  /** Explicit hard turn limit. Omitted by default for open-ended execution. */
  readonly turnBudget?: TurnBudget;
}

export interface RuntimePolicyConfig {
  readonly execution?: ExecutionConfig;
  readonly verification?: VerificationConfig;
}
''',
)
replace(
    policy,
    '''const TIER_BUDGETS: Record<ModelTier, { turns: number; tools: number; timeout: number }> = {
  low: { turns: 12, tools: 40, timeout: 10 * 60_000 },
  standard: { turns: 24, tools: 80, timeout: 20 * 60_000 },
  high: { turns: 40, tools: 140, timeout: 35 * 60_000 },
  critical: { turns: 64, tools: 220, timeout: 60 * 60_000 },
};
''',
    '''const TIER_BUDGETS: Record<ModelTier, { tools: number; timeout: number }> = {
  low: { tools: 40, timeout: 10 * 60_000 },
  standard: { tools: 80, timeout: 20 * 60_000 },
  high: { tools: 140, timeout: 35 * 60_000 },
  critical: { tools: 220, timeout: 60 * 60_000 },
};

function resolveTurnBudget(config: RuntimePolicyConfig): TurnBudget {
  const configured = config.execution?.turnBudget;
  if (!configured) return {};

  const maxTurns = configured.maxTurns;
  const graceTurns = configured.graceTurns;
  if (maxTurns === undefined) {
    if (graceTurns !== undefined) {
      throw new Error("execution.turnBudget.graceTurns requires maxTurns");
    }
    return {};
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error("execution.turnBudget.maxTurns must be a positive integer");
  }
  if (graceTurns !== undefined && (!Number.isInteger(graceTurns) || graceTurns < 0)) {
    throw new Error("execution.turnBudget.graceTurns must be a non-negative integer");
  }

  return {
    maxTurns,
    ...(graceTurns !== undefined ? { graceTurns } : {}),
  };
}
''',
)
replace(
    policy,
    '    turnBudget: { maxTurns: budget.turns, graceTurns: 2 },',
    '    turnBudget: resolveTurnBudget(config),',
)

budget_guard = "modules/phenix-pi/packages/phenix-suite/runtime/budget-guard.ts"
replace(
    budget_guard,
    '''        // Turn limit — abort (accounting for grace turns)
        if (
          this.config.turnBudget.maxTurns > 0 &&
          this.turns > this.config.turnBudget.maxTurns + this.config.turnBudget.graceTurns
        ) {
          return {
            violation: {
              code: "TURN_BUDGET_EXCEEDED",
              message:
                `Turn budget exceeded: ${this.turns} turns, limit is ` +
                `${this.config.turnBudget.maxTurns} + ${this.config.turnBudget.graceTurns} grace.`,
            },
          };
        }
''',
    '''        // Turn limits are opt-in. Open-ended work is not aborted by tier heuristics.
        const maxTurns = this.config.turnBudget.maxTurns;
        if (maxTurns !== undefined) {
          const graceTurns = this.config.turnBudget.graceTurns ?? 0;
          if (this.turns > maxTurns + graceTurns) {
            return {
              violation: {
                code: "TURN_BUDGET_EXCEEDED",
                message:
                  `Turn budget exceeded: ${this.turns} turns, limit is ` +
                  `${maxTurns} + ${graceTurns} grace.`,
              },
            };
          }
        }
''',
)

codec = "modules/phenix-pi/packages/phenix-suite/subagents/contract-codec.ts"
replace(
    codec,
    '''  const turnBudget = runtime.turnBudget;
  if (
    typeof turnBudget.maxTurns !== "number" ||
    turnBudget.maxTurns < 1 ||
    !Number.isInteger(turnBudget.maxTurns)
  ) {
    throw new Error(`${ctx()}: runtime.turnBudget.maxTurns must be a positive integer`);
  }
  if (
    typeof turnBudget.graceTurns !== "number" ||
    turnBudget.graceTurns < 0 ||
    !Number.isInteger(turnBudget.graceTurns)
  ) {
    throw new Error(`${ctx()}: runtime.turnBudget.graceTurns must be a non-negative integer`);
  }
''',
    '''  const turnBudget = runtime.turnBudget;
  if (
    turnBudget.maxTurns !== undefined &&
    (typeof turnBudget.maxTurns !== "number" ||
      turnBudget.maxTurns < 1 ||
      !Number.isInteger(turnBudget.maxTurns))
  ) {
    throw new Error(
      `${ctx()}: runtime.turnBudget.maxTurns must be a positive integer when set`,
    );
  }
  if (
    turnBudget.graceTurns !== undefined &&
    (typeof turnBudget.graceTurns !== "number" ||
      turnBudget.graceTurns < 0 ||
      !Number.isInteger(turnBudget.graceTurns))
  ) {
    throw new Error(
      `${ctx()}: runtime.turnBudget.graceTurns must be a non-negative integer when set`,
    );
  }
  if (turnBudget.maxTurns === undefined && turnBudget.graceTurns !== undefined) {
    throw new Error(`${ctx()}: runtime.turnBudget.graceTurns requires maxTurns`);
  }
''',
)

policy_test = "modules/phenix-pi/tests/policy.test.ts"
replace(
    policy_test,
    '''  it("base execution has a standard non-code budget floor", () => {
    const policy = resolveExecutionPolicy({
      role: null,
      task: "Do something minimal",
      requirements: [],
      cwd: process.cwd(),
      config,
    });
    assert.equal(policy.agent, "phenix.base");
    assert.equal(policy.tier, "standard");
    assert.equal(policy.turnBudget.maxTurns, 24);
    assert.equal(policy.thinking, "medium");
    assert.equal(policy.criticRequired, false);
    assert.equal(policy.verificationCommands.length, 0);
    assert.equal(policy.allowedChildren.length, 0);
  });
''',
    '''  it("base execution has a standard profile without a default turn cap", () => {
    const policy = resolveExecutionPolicy({
      role: null,
      task: "Do something minimal",
      requirements: [],
      cwd: process.cwd(),
      config,
    });
    assert.equal(policy.agent, "phenix.base");
    assert.equal(policy.tier, "standard");
    assert.deepEqual(policy.turnBudget, {});
    assert.equal(policy.thinking, "medium");
    assert.equal(policy.criticRequired, false);
    assert.equal(policy.verificationCommands.length, 0);
    assert.equal(policy.allowedChildren.length, 0);
  });

  it("preserves an explicitly configured hard turn cap", () => {
    const policy = resolveExecutionPolicy({
      role: "scout",
      task: "Perform one bounded lookup",
      requirements: [],
      cwd: process.cwd(),
      config: {
        ...config,
        execution: { turnBudget: { maxTurns: 8, graceTurns: 1 } },
      },
    });
    assert.deepEqual(policy.turnBudget, { maxTurns: 8, graceTurns: 1 });
  });
''',
)

budget_test = "modules/phenix-pi/tests/budget-guard.test.ts"
text = Path(budget_test).read_text()
text = text.replace('turnBudget: { maxTurns: 100, graceTurns: 0 },', 'turnBudget: {},')
needle = '''  it("turn limit aborts with TURN_BUDGET_EXCEEDED", () => {
'''
insert = '''  it("does not impose a turn limit when maxTurns is omitted", () => {
    const guard = new BudgetGuard({
      turnBudget: {},
      toolBudget: { soft: 100, hard: 100, block: [] },
      timeoutMs: 0,
    });

    for (let index = 0; index < 200; index++) {
      assert.equal(guard.observe(turnEndEvent()).violation, undefined);
    }
    assert.equal(guard.getTurns(), 200);
  });

'''
if needle not in text:
    raise SystemExit(f"pattern not found in {budget_test}: turn-limit test")
Path(budget_test).write_text(text.replace(needle, insert + needle, 1))
