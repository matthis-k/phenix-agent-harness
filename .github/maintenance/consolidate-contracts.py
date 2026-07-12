from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    target = ROOT / path
    content = target.read_text()
    count = content.count(old)
    if count != expected:
        raise RuntimeError(f"{path}: expected {expected} matches, found {count}: {old!r}")
    target.write_text(content.replace(old, new))


for path in [
    "modules/phenix-pi/extensions/phenix-subagents/contract.ts",
    "modules/phenix-pi/extensions/phenix-subagents/contract-projection.ts",
    "modules/phenix-pi/extensions/phenix-subagents/handle-types.ts",
]:
    replace(
        path,
        'import type { JsonSchema } from "./contracts.ts";',
        'import type { JsonSchema } from "../phenix-contracts/definitions.ts";',
    )

replace(
    "modules/phenix-pi/extensions/phenix-runtime/child-session-types.ts",
    'import type { JsonSchema } from "../phenix-subagents/contracts.ts";',
    'import type { JsonSchema } from "../phenix-contracts/definitions.ts";',
)

for path in [
    "modules/phenix-pi/extensions/phenix-subagents/attempt-runner.ts",
    "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts",
    "modules/phenix-pi/extensions/phenix-subagents/handle-evaluation.ts",
]:
    replace(
        path,
        'import { validateContract } from "./contracts.ts";',
        'import { validateSchema } from "../phenix-contracts/validator.ts";',
    )
    replace(path, "validateContract(", "validateSchema(")

replace(
    "modules/phenix-pi/extensions/phenix-runtime/completion-tool.ts",
    'import { validateContract } from "../phenix-subagents/contracts.ts";',
    'import { validateSchema } from "../phenix-contracts/validator.ts";',
)
replace(
    "modules/phenix-pi/extensions/phenix-runtime/completion-tool.ts",
    "validateContract(",
    "validateSchema(",
)

replace(
    "modules/phenix-pi/tests/contracts.test.ts",
    '''import {
  assertOutputSchema,
  validateContract,
} from "../extensions/phenix-subagents/contracts.ts";''',
    '''import {
  assertOutputSchema,
  validateSchema,
} from "../extensions/phenix-contracts/validator.ts";''',
)
replace(
    "modules/phenix-pi/tests/contracts.test.ts",
    "validateContract(",
    "validateSchema(",
    expected=2,
)
