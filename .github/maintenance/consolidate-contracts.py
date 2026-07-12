from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace(path: str, old: str, new: str, minimum: int = 1) -> None:
    target = ROOT / path
    content = target.read_text()
    count = content.count(old)
    if count < minimum:
        raise RuntimeError(f"{path}: expected at least {minimum} matches, found {count}: {old!r}")
    target.write_text(content.replace(old, new))


for path in [
    "modules/phenix-pi/extensions/phenix-subagents/contract.ts",
    "modules/phenix-pi/extensions/phenix-subagents/contract-projection.ts",
    "modules/phenix-pi/extensions/phenix-subagents/handle-types.ts",
]:
    replace(
        path,
        'from "./contracts.ts"',
        'from "../phenix-contracts/definitions.ts"',
    )

replace(
    "modules/phenix-pi/extensions/phenix-runtime/child-session-types.ts",
    'from "../phenix-subagents/contracts.ts"',
    'from "../phenix-contracts/definitions.ts"',
)

for path in [
    "modules/phenix-pi/extensions/phenix-subagents/attempt-runner.ts",
    "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts",
    "modules/phenix-pi/extensions/phenix-subagents/handle-evaluation.ts",
]:
    replace(
        path,
        'from "./contracts.ts"',
        'from "../phenix-contracts/validator.ts"',
    )
    replace(path, "validateContract", "validateSchema", minimum=2)

replace(
    "modules/phenix-pi/extensions/phenix-runtime/completion-tool.ts",
    'from "../phenix-subagents/contracts.ts"',
    'from "../phenix-contracts/validator.ts"',
)
replace(
    "modules/phenix-pi/extensions/phenix-runtime/completion-tool.ts",
    "validateContract",
    "validateSchema",
    minimum=2,
)

replace(
    "modules/phenix-pi/tests/contracts.test.ts",
    'from "../extensions/phenix-subagents/contracts.ts"',
    'from "../extensions/phenix-contracts/validator.ts"',
)
replace(
    "modules/phenix-pi/tests/contracts.test.ts",
    "validateContract",
    "validateSchema",
    minimum=3,
)
