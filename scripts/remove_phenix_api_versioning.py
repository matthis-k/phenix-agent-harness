from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content)


def replace(path: str, old: str, new: str, *, expected: int | None = 1) -> None:
    content = read(path)
    count = content.count(old)
    if expected is not None and count != expected:
        raise RuntimeError(f"{path}: expected {expected} occurrences, found {count}: {old!r}")
    write(path, content.replace(old, new))


def replace_if_present(path: str, old: str, new: str) -> None:
    content = read(path)
    if old in content:
        write(path, content.replace(old, new))


def remove_matching_lines(path: Path, pattern: re.Pattern[str]) -> int:
    content = path.read_text()
    lines = content.splitlines(keepends=True)
    kept = [line for line in lines if not pattern.search(line)]
    removed = len(lines) - len(kept)
    if removed:
        path.write_text("".join(kept))
    return removed


# Routing policy is one canonical policy, not a versioned public contract.
replace(
    "modules/phenix-pi/framework/routing/policy-model-resolver.ts",
    "export interface RoutingPolicy {\n  readonly revision: string;\n",
    "export interface RoutingPolicy {\n",
)
replace(
    "modules/phenix-pi/suite/phenix-routing-policy.ts",
    'export const defaultRoutingPolicy: RoutingPolicy = Object.freeze({\n  revision: "phenix-routing-v4",\n',
    "export const defaultRoutingPolicy: RoutingPolicy = Object.freeze({\n",
)

policy_revision = re.compile(r"policyRevision")
removed_policy_lines = 0
for path in (ROOT / "modules/phenix-pi").rglob("*.ts"):
    removed_policy_lines += remove_matching_lines(path, policy_revision)
if removed_policy_lines == 0:
    raise RuntimeError("expected policyRevision producers or consumers")

# Phenix-owned persisted structures have one current shape. Git history carries old shapes.
versioned_files = [
    "modules/phenix-pi/domain/run/model.ts",
    "modules/phenix-pi/domain/diagnostics.ts",
    "modules/phenix-pi/application/dynamic-workflow-compiler.ts",
    "modules/phenix-pi/adapters/persistence/jsonl-diagnostic-log.ts",
    "modules/phenix-pi/tests/diagnostic-event-bridge.test.ts",
    "modules/phenix-pi/tests/health-diagnostic-log.test.ts",
    "modules/phenix-pi/tests/log-command.test.ts",
    "modules/phenix-pi/tests/dynamic-workflow-compiler.test.ts",
    "modules/phenix-pi/tests/dynamic-workflow-runtime.test.ts",
]
version_line = re.compile(r"^\s*(?:readonly\s+)?version:\s*1[,;]\s*$")
removed_versions = 0
for relative in versioned_files:
    path = ROOT / relative
    if path.exists():
        removed_versions += remove_matching_lines(path, version_line)
if removed_versions == 0:
    raise RuntimeError("expected fixed Phenix version discriminators")

replace_if_present(
    "modules/phenix-pi/application/dynamic-workflow-compiler.ts",
    "digest({ version: 1, proposal, definitionDigests, schemaDigests })",
    "digest({ proposal, definitionDigests, schemaDigests })",
)
replace_if_present(
    "modules/phenix-pi/application/dynamic-workflow-compiler.ts",
    "Object.freeze({ version: 1, graphDigest, definitionDigests, schemaDigests })",
    "Object.freeze({ graphDigest, definitionDigests, schemaDigests })",
)
replace_if_present(
    "modules/phenix-pi/application/dynamic-workflow-runtime.ts",
    "    left.version === right.version &&\n",
    "",
)
replace_if_present(
    "modules/phenix-pi/application/diagnostic-event-bridge.ts",
    "          version: data.version,\n",
    "",
)
replace_if_present(
    "docs/INTERFACES.md",
    "the concrete model selected by the versioned routing policy",
    "the concrete model selected by the routing policy",
)

# Session-row projections accept intentionally partial host-neutral test snapshots.
runs_view = "modules/phenix-pi/application/workspace/views/runs-view.ts"
replace_if_present(runs_view, "run.compiled.budget", "run.compiled?.budget")
replace_if_present(runs_view, "run.compiled.difficulty", "run.compiled?.difficulty")

# Keep the root-extension test double faithful to the shared event bus.
replace(
    "modules/phenix-pi/tests/root-extension-session.test.ts",
    "      events: { emit: () => undefined },\n",
    "      events: { emit: () => undefined, on: () => undefined },\n",
)

# Audit the current tree. External package/protocol versions and numeric state revisions are allowed;
# Phenix API version fields and routing revision identifiers are not.
violations: list[str] = []
for path in (ROOT / "modules/phenix-pi").rglob("*"):
    if not path.is_file() or path.suffix not in {".ts", ".md"}:
        continue
    text = path.read_text()
    relative = path.relative_to(ROOT).as_posix()
    if "policyRevision" in text or re.search(r"phenix-routing-v\d+", text):
        violations.append(relative)
    if "/tests/" not in f"/{relative}" and re.search(
        r"^\s*(?:readonly\s+)?version:\s*\d+[,;]\s*$", text, re.MULTILINE
    ):
        violations.append(relative)
    if "/tests/" not in f"/{relative}" and re.search(
        r"\b(?:request|outcome|schema|workflow|agent|phenix)[A-Za-z0-9._-]*(?:\.v|-v)\d+\b",
        text,
    ):
        violations.append(relative)

if violations:
    unique = "\n".join(sorted(set(violations)))
    raise RuntimeError(f"versioned Phenix API identifiers remain:\n{unique}")

print(
    f"removed {removed_policy_lines} routing revision consumers and "
    f"{removed_versions} fixed version discriminators"
)
