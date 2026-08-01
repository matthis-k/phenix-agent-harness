from pathlib import Path

path = Path(__file__).with_name("apply_session_budget_mode.py")
source = path.read_text()

needle = '''def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))
'''
replacement = needle + '''\n\ndef replace_all(path: str, old: str, new: str, expected: int) -> None:
    content = read(path)
    count = content.count(old)
    if count != expected:
        raise RuntimeError(f"{path}: expected {expected} occurrences, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new))
'''
if source.count(needle) != 1:
    raise RuntimeError("replace_once helper changed")
source = source.replace(needle, replacement, 1)

no_op = '''replace_once(
    "modules/phenix-pi/composition/execution-kernel.ts",
    '    models,\\n    ids,\\n',
    '    models,\\n    ids,\\n',
)
'''
if source.count(no_op) != 1:
    raise RuntimeError("execution-kernel no-op replacement changed")
source = source.replace(no_op, "", 1)

repeated = '''replace_once(
    "modules/phenix-pi/application/budget-suspension.ts",
    '  readonly timeoutRemainingMs: number;\\n',
    '  readonly timeoutRemainingMs?: number;\\n',
)
replace_once(
    "modules/phenix-pi/application/budget-suspension.ts",
    '  readonly timeoutRemainingMs: number;\\n',
    '  readonly timeoutRemainingMs?: number;\\n',
)
replace_once(
    "modules/phenix-pi/application/budget-suspension.ts",
    '  readonly timeoutRemainingMs: number;\\n',
    '  readonly timeoutRemainingMs?: number;\\n',
)
'''
combined = '''replace_all(
    "modules/phenix-pi/application/budget-suspension.ts",
    '  readonly timeoutRemainingMs: number;\\n',
    '  readonly timeoutRemainingMs?: number;\\n',
    3,
)
'''
if source.count(repeated) != 1:
    raise RuntimeError("budget timeout field replacements changed")
source = source.replace(repeated, combined, 1)

marker = '''replace_once(
    "modules/phenix-pi/application/session-profile-facade.ts",
    '    left.modelSet === right.modelSet &&\\n    left.difficulty === right.difficulty\\n',
    '    left.modelSet === right.modelSet &&\\n    left.difficulty === right.difficulty &&\\n    left.budget === right.budget\\n',
)
'''
addition = marker + '''replace_once(
    "modules/phenix-pi/application/session-profile-facade.ts",
    '  DEFAULT_SESSION_PROFILE,\\n',
    '',
)
'''
if source.count(marker) != 1:
    raise RuntimeError("session profile marker changed")
source = source.replace(marker, addition, 1)

print_marker = 'print("session budget mode patch applied")\n'
fixture_patch = '''replace_once(
    "modules/phenix-pi/tests/workspace-view-registry.test.ts",
    '      definitionId: kind === "root" ? "session.root" : "agent.test",\\n    } as RunSnapshot,\\n',
    '      definitionId: kind === "root" ? "session.root" : "agent.test",\\n      compiled: {\\n        definitionId: kind === "root" ? "session.root" : "agent.test",\\n        input: {},\\n        outputSchemaId: "test.output",\\n        tools: [],\\n        limits: { timeoutMs: 60_000 },\\n        capabilities: {\\n          invokableDefinitions: [],\\n          maxDepth: 1,\\n          mayDetach: false,\\n          maySend: false,\\n          mayCancelChildren: false,\\n        },\\n        invocation: { wait: "await" },\\n      },\\n    } as RunSnapshot,\\n',
)

'''
if source.count(print_marker) != 1:
    raise RuntimeError("patch completion marker changed")
source = source.replace(print_marker, fixture_patch + print_marker, 1)

path.write_text(source)
