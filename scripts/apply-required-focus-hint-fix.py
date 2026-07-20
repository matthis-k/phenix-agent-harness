from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match in {path}, found {count}")
    target.write_text(text.replace(old, new, 1))


gate = "modules/phenix-pi/packages/phenix-suite/composition/workflow-turn-gate.ts"
replace_once(
    gate,
    '''  readonly requiredAgents: readonly string[];
  readonly mustMatchUserTask: boolean;
''',
    '''  readonly requiredAgents: readonly string[];
''',
)
replace_once(
    gate,
    '''const TASK_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "do",
  "for",
  "from",
  "in",
  "it",
  "of",
  "on",
  "or",
  "please",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

''',
    '',
)
replace_once(
    gate,
    '''function normalizedTaskTokens(value: string): readonly string[] {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2 && !TASK_STOP_WORDS.has(token)))];
}

''',
    '',
)
replace_once(
    gate,
    '''function taskMatchesUserRequest(task: string, userTask: string): boolean {
  if (isHarnessPreflightTask(task, userTask)) return false;

  const userTokens = normalizedTaskTokens(userTask);
  if (userTokens.length === 0) return true;
  const delegatedTokens = new Set(normalizedTaskTokens(task));
  const overlap = userTokens.filter((token) => delegatedTokens.has(token)).length;
  const requiredOverlap = userTokens.length >= 3 ? 2 : 1;
  return overlap >= requiredOverlap;
}

''',
    '',
)
replace_once(
    gate,
    '''      requiredAgents,
      mustMatchUserTask: true,
    });
''',
    '''      requiredAgents,
    });
''',
)
replace_once(
    gate,
    '''      requiredAgents,
      taskMatchRequired: true,
    });
''',
    '''      requiredAgents,
      preflightTaskRejected: true,
    });
''',
)
replace_once(
    gate,
    '''    if (state.mustMatchUserTask && !taskMatchesUserRequest(task, state.userTask)) {
      return deny(
        "The delegated task must be a bounded part of the user's request. " +
          "Do not delegate skill loading, contract loading, workflow inspection, or other Phenix harness preflight.",
        state.requiredAgents,
      );
    }
''',
    '''    if (isHarnessPreflightTask(task, state.userTask)) {
      return deny(
        "Required workflow delegation must describe user work, not skill loading, contract loading, workflow inspection, or other Phenix harness preflight.",
        state.requiredAgents,
      );
    }
''',
)
replace_once(
    gate,
    '''      agent,
      taskMatchRequired: state.mustMatchUserTask,
    });
''',
    '''      agent,
      preflightTaskRejected: true,
    });
''',
)
text = (ROOT / gate).read_text()
text = text.replace('          mustMatchUserTask: false,\n', '')
(ROOT / gate).write_text(text)

replace_once(
    "modules/phenix-pi/tests/workflow-turn-gate.test.ts",
    '  it("rejects harness preflight and unrelated tasks as required delegation", () => {',
    '  it("rejects harness preflight but treats the required root task as a focus hint", () => {',
)
replace_once(
    "modules/phenix-pi/tests/workflow-turn-gate.test.ts",
    '''      /bounded part of the user's request/i,
    );
    assert.match(
      gate.authorize(
        invocation("phenix_workflow", {
          action: "spawn",
          agent: "base",
          task: "Summarize an unrelated deployment guide.",
        }),
      ) ?? "",
      /bounded part of the user's request/i,
    );
''',
    '''      /must describe user work/i,
    );
    assert.equal(
      gate.authorize(
        invocation("phenix_workflow", {
          action: "spawn",
          agent: "base",
          task: "Summarize an unrelated deployment guide.",
        }),
      ),
      undefined,
    );
''',
)

print("applied required focus-hint gate fix")
