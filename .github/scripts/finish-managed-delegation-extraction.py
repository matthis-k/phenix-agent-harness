from pathlib import Path

composition = Path("modules/phenix-pi/extensions/phenix.ts")
text = composition.read_text()
text = text.replace(
'''  const managers = createSessionSubagentManagerFactory({
    sessions: sessionRuntime,
    acceptance,
  });

  coordinator = new AgentExecutionCoordinator({
    managers,
''',
'''  const managers = createSessionSubagentManagerFactory({
    sessions: sessionRuntime,
    acceptance,
  });
  const managedRegistry = createManagedSubagentRegistry();
  const delegationRuntime = createManagedDelegationRuntime({
    managers,
    registry: managedRegistry,
  });

  coordinator = new AgentExecutionCoordinator({
    delegationRuntime,
''')
composition.write_text(text)

architecture = Path("modules/phenix-pi/tests/architecture-boundaries.test.ts")
text = architecture.read_text()
text = text.replace(
'        "phenix-runtime/session-subagent-adapter.ts",\n',
'        "phenix-runtime/session-subagent-adapter.ts",\n        "phenix-runtime/managed-subagent-registry.ts",\n')
text = text.replace(
'''  it("keeps the coordinator on the managed subagent surface", () => {
    assertNoDependencies(selectedFiles("phenix-subagents/coordinator.ts"), [
      "../phenix-runtime/child-session-backend",
      "../phenix-runtime/sdk-child-session-backend",
      "../phenix-runtime/subagent-session-runtime",
      "./execution-quality-service",
      "./attempt-runner",
    ]);
  });
''',
'''  it("keeps the coordinator independent from managed execution mechanics", () => {
    assertNoDependencies(selectedFiles("phenix-subagents/coordinator.ts"), [
      "../phenix-runtime/child-session-backend",
      "../phenix-runtime/sdk-child-session-backend",
      "../phenix-runtime/subagent-session-runtime",
      "../phenix-runtime/subagent-manager",
      "../phenix-runtime/subagent-manager-factory",
      "./execution-quality-service",
      "./attempt-runner",
    ]);
  });
''')
architecture.write_text(text)

for obsolete in [
    Path("modules/phenix-pi/extensions/phenix-runtime/child-session-registry.ts"),
    Path("modules/phenix-pi/tests/child-session-registry.test.ts"),
]:
    if obsolete.exists():
        obsolete.unlink()
