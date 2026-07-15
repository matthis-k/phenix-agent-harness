from pathlib import Path
import re

attempt = Path("modules/phenix-pi/extensions/phenix-subagents/attempt-runner.ts")
text = attempt.read_text()
text = text.replace("  ChildSessionBackend,\n", "")
text = text.replace(
    '''export type CriticFactory = (
  backend: ChildSessionBackend,
  input: CriticRunInput,
) => Promise<CriticRunResult>;
''',
    '''export type CriticFactory = (input: CriticRunInput) => Promise<CriticRunResult>;
''',
)
text = text.replace("  readonly backend: ChildSessionBackend;\n", "")
text = text.replace("    backend,\n", "")
text = text.replace("criticResult = await criticFactory(backend, {", "criticResult = await criticFactory({")
attempt.write_text(text)

coordinator = Path("modules/phenix-pi/extensions/phenix-subagents/coordinator.ts")
text = coordinator.read_text()
text = text.replace('import { randomUUID } from "node:crypto";\n', "")
text = text.replace(
    'import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";\n',
    'import type { ExtensionContext } from "@earendil-works/pi-coding-agent";\n',
)
text = text.replace('import { validateSchema } from "../phenix-contracts/validator.ts";\n', "")
text = text.replace('import { agentClientRef } from "../phenix-kernel/refs.ts";\n', "")
text = text.replace('import { resolveChildRoute } from "../phenix-routing/child-route.ts";\n', "")
text = text.replace(
    '''import type {
  ChildRun,
  ChildSessionBackend,
  ChildSessionSpec,
} from "../phenix-runtime/child-session-types.ts";
''',
    '''import type { ChildRun } from "../phenix-runtime/child-session-types.ts";
''',
)
text = text.replace(
    '''import {
  ChildRuntimeError,
  childRunId,
  isChildRuntimeErrorCode,
} from "../phenix-runtime/child-session-types.ts";
''',
    '''import {
  ChildRuntimeError,
  childRunId,
} from "../phenix-runtime/child-session-types.ts";
''',
)
text = text.replace('import { computeOptionsDigest } from "../phenix-workflow/workflow-projection.ts";\n', "")
text = re.sub(
    r'import type \{\n  CriticRunInput,\n  CriticRunResult,\n  VerificationInput,\n  VerificationResult,\n\} from "\.\/attempt-runner\.ts";\n',
    "",
    text,
    count=1,
)
text = text.replace(
    'import type { CriticValue, HandleRecord, WorkflowBinding } from "./handle-types.ts";\n',
    'import type { HandleRecord, WorkflowBinding } from "./handle-types.ts";\n',
)
text = text.replace(
    'import { CRITIC_OUTPUT_SCHEMA, HANDLE_VERSION, isTerminalHandleStatus } from "./handle-types.ts";\n',
    'import { HANDLE_VERSION, isTerminalHandleStatus } from "./handle-types.ts";\n',
)
text = text.replace('import { runVerificationCommands } from "./verification.ts";\n', "")
quality_import = 'import type { ExecutionQualityService } from "./execution-quality-service.ts";\n'
anchor = 'import { createWorkflowExecutionCompiler } from "./workflow-execution-compiler.ts";\n'
if quality_import not in text:
    text = text.replace(anchor, quality_import + anchor)

text = text.replace(
    '''export interface AgentExecutionCoordinatorOptions {
  readonly backend: ChildSessionBackend;
  readonly sessionRuntime: SubagentSessionRuntime;
  readonly resolveModelRegistry: () => ModelRegistry;
''',
    '''export interface AgentExecutionCoordinatorOptions {
  readonly sessionRuntime: SubagentSessionRuntime;
  readonly quality: ExecutionQualityService;
''',
)
text = text.replace(
    '''export class AgentExecutionCoordinator {
  private readonly backend: ChildSessionBackend;
  private readonly sessionRuntime: SubagentSessionRuntime;
  private readonly resolveModelRegistry: () => ModelRegistry;
''',
    '''export class AgentExecutionCoordinator {
  private readonly sessionRuntime: SubagentSessionRuntime;
  private readonly quality: ExecutionQualityService;
''',
)
text = text.replace(
    '''  constructor(options: AgentExecutionCoordinatorOptions) {
    this.backend = options.backend;
    this.sessionRuntime = options.sessionRuntime;
    this.resolveModelRegistry = options.resolveModelRegistry;
''',
    '''  constructor(options: AgentExecutionCoordinatorOptions) {
    this.sessionRuntime = options.sessionRuntime;
    this.quality = options.quality;
''',
)
text = text.replace(
    '''            verify: (verificationInput) => this.verifyProducer(verificationInput),
            criticFactory: (backend, criticInput) => this.runCritic(backend, criticInput),
            backend: this.backend,
''',
    '''            verify: (verificationInput) => this.quality.verify(verificationInput),
            criticFactory: (criticInput) => this.quality.review(criticInput),
''',
)
text, count = re.subn(
    r'\n  private async verifyProducer\(.*?\n  // ── Background handle lifecycle',
    '\n  // ── Background handle lifecycle',
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError(f"expected one quality-method block, found {count}")
coordinator.write_text(text)

composition = Path("modules/phenix-pi/extensions/phenix.ts")
text = composition.read_text()
quality_import = '''import { createExecutionQualityService } from "./phenix-subagents/execution-quality-service.ts";
'''
anchor = 'import { defaultAgentClients } from "./phenix-subagents/definitions.ts";\n'
if quality_import not in text:
    text = text.replace(anchor, anchor + quality_import)
quality_block = '''  const quality = createExecutionQualityService({
    backend,
    resolveModelRegistry: () => getRuntimeServices().modelRegistry,
  });

'''
coordinator_anchor = '  // ── 7. Construct the coordinator ─────────────────────────────────────\n'
if quality_block not in text:
    text = text.replace(coordinator_anchor, quality_block + coordinator_anchor)
text = text.replace(
    '''  coordinator = new AgentExecutionCoordinator({
    backend,
    sessionRuntime,
    resolveModelRegistry: () => getRuntimeServices().modelRegistry,
''',
    '''  coordinator = new AgentExecutionCoordinator({
    sessionRuntime,
    quality,
''',
)
composition.write_text(text)

runtime_test = Path("modules/phenix-pi/tests/runtime-finalization.test.ts")
text = runtime_test.read_text()
text = text.replace('      backend: { kind: "sdk" } as never,\n', "")
runtime_test.write_text(text)
