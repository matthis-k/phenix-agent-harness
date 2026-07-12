from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "modules/phenix-pi/extensions/phenix-subagents/attempt-runner.ts"
content = PATH.read_text()

replacements = [
    (
        'import { validateSchema } from "../phenix-contracts/validator.ts";\n',
        'import { validateSchema } from "../phenix-contracts/validator.ts";\n'
        'import { agentClientRef } from "../phenix-kernel/refs.ts";\n',
    ),
    (
        'import type { HandleRecord, ProducerCycleRecord, VerificationSummary } from "./handle-types.ts";\n',
        'import type {\n'
        '  CriticFinding,\n'
        '  HandleRecord,\n'
        '  ProducerCycleRecord,\n'
        '  VerificationSummary,\n'
        '} from "./handle-types.ts";\n',
    ),
    (
        '''  readonly findings: readonly {
    readonly severity: string;
    readonly description: string;
    readonly evidence: string;
    readonly requirement?: string;
  }[];
''',
        '  readonly findings: readonly CriticFinding[];\n',
    ),
    ('        findings: criticResult.findings as any,\n', '        findings: criticResult.findings,\n'),
    ('        findings: cycleRecord.critic.findings as any,\n', '        findings: cycleRecord.critic.findings,\n'),
    (
        '''    agentClient: {
      id: spec.agent.replace("phenix.", "") as any,
      kind: "agent" as any,
    },
''',
        '    agentClient: agentClientRef(spec.agent.replace(/^phenix\\./, "")),\n',
    ),
]

for old, new in replacements:
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match, found {count}: {old[:100]!r}")
    content = content.replace(old, new, 1)

PATH.write_text(content)
