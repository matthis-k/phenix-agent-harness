from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"expected patch context missing in {path}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "modules/phenix-pi/extensions/phenix-routing/stream-proxy.ts",
    "  const route = getActiveRouteForSession(sessionId);\n",
    "  let route = getActiveRouteForSession(sessionId);\n",
)

replace_once(
    "modules/phenix-pi/tests/routing-resolver.test.ts",
    '''describe("Route resolution profile → difficulty", () => {
  const config = buildBundledConfig();

  it("D0 profile resolves to D0 route", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "coordinator",
      profile: {
        complexity: 0,
        uncertainty: 0,
        consequence: 0,
        breadth: 0,
        coupling: 0,
        novelty: 0,
      },
      modelRegistry: goRegistry(),
      config,
    });
    assert.equal(route.difficulty, "D0");
  });

  it("D3 profile resolves to D3 route", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "coordinator",
      profile: {
        complexity: 4,
        uncertainty: 4,
        consequence: 4,
        breadth: 4,
        coupling: 4,
        novelty: 4,
      },
      modelRegistry: goRegistry(),
      config,
    });
    assert.equal(route.difficulty, "D3");
  });
});
''',
    '''describe("Workflow-owned route difficulty", () => {
  const config = buildBundledConfig();

  it("resolves the workflow-derived D0 route", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "coordinator",
      difficulty: "D0",
      modelRegistry: goRegistry(),
      config,
    });
    assert.equal(route.difficulty, "D0");
  });

  it("resolves the workflow-derived D3 route", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "coordinator",
      difficulty: "D3",
      modelRegistry: goRegistry(),
      config,
    });
    assert.equal(route.difficulty, "D3");
  });
});
''',
)
