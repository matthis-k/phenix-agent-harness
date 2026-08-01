from pathlib import Path

root = Path(__file__).resolve().parents[2]

replacements = {
    "modules/phenix-pi/tests/failure-policy.test.ts": [
        (
            '''import {
  defaultAgentFailureRetryable,
  type FailureCategory,
} from "../domain/shared.ts";''',
            '''import { defaultAgentFailureRetryable, type FailureCategory } from "../domain/shared.ts";''',
        ),
    ],
    "modules/phenix-pi/tests/workflow-planner.test.ts": [
        (
            '''  const results = new Map<string, readonly unknown[]>([
    [
      "left",
      [failed({ code: "agent_reported_failure", message: "rejected", retryable: false })],
    ],
  ]);''',
            '''  const results = new Map<string, readonly unknown[]>([
    ["left", [failed({ code: "agent_reported_failure", message: "rejected", retryable: false })]],
  ]);''',
        ),
    ],
}

for relative, edits in replacements.items():
    path = root / relative
    text = path.read_text()
    for old, new in edits:
        count = text.count(old)
        if count != 1:
            raise RuntimeError(f"{relative}: expected one formatter target, found {count}")
        text = text.replace(old, new, 1)
    path.write_text(text)

(root / ".github/workflows/apply-pr232-format.yml").unlink()
Path(__file__).unlink()
