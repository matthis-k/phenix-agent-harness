from pathlib import Path


def replace_required(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"expected patch context missing in {path}")
    file.write_text(text.replace(old, new, 1))


replace_required(
    "modules/phenix-pi/extensions/phenix-routing/resolver.ts",
    'import { difficultyForProfile } from "./classifier.ts";\n',
    '',
)
replace_required(
    "modules/phenix-pi/extensions/phenix-routing/resolver.ts",
    '''  readonly difficulty?: Difficulty;
  readonly profile?: {
    readonly complexity: number;
    readonly uncertainty: number;
    readonly consequence: number;
    readonly breadth: number;
    readonly coupling: number;
    readonly novelty: number;
  };
''',
    '''  readonly difficulty: Difficulty;
''',
)
replace_required(
    "modules/phenix-pi/tests/routing-stream-failover.test.ts",
    '''  const sessionId = "routing-failover-after-output";
  clearActiveRouteForSession(sessionId);

  const events = await collect(
''',
    '''  const sessionId = "routing-failover-after-output";
  clearActiveRouteForSession(sessionId);
  primeEntryRoute(sessionId, [first, second]);

  const events = await collect(
''',
)
