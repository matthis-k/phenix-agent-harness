#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

git apply --check .github/bootstrap/runtime-finalization.patch
git apply .github/bootstrap/runtime-finalization.patch

mkdir -p scripts .githooks .github/workflows modules/phenix-pi/tests

cat > scripts/check.sh <<'EOF_CHECK'
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

mode="${1:-full}"

case "$mode" in
  staged)
    git diff --cached --check

    if git diff --cached --quiet -- \
      flake.nix flake.lock modules scripts .githooks .github/workflows; then
      exit 0
    fi

    nix build --no-link .#phenix-runtime-tests .#phenix-qa-tests
    ;;
  full)
    git diff --check
    nix flake check --print-build-logs
    ;;
  *)
    printf 'usage: %s [staged|full]\n' "$0" >&2
    exit 2
    ;;
esac
EOF_CHECK

cat > scripts/setup-git-hooks.sh <<'EOF_SETUP'
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

git config --local core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push

printf 'Configured core.hooksPath=.githooks for %s\n' "$repo_root"
EOF_SETUP

cat > .githooks/pre-commit <<'EOF_PRE_COMMIT'
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
exec "$repo_root/scripts/check.sh" staged
EOF_PRE_COMMIT

cat > .githooks/pre-push <<'EOF_PRE_PUSH'
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
exec "$repo_root/scripts/check.sh" full
EOF_PRE_PUSH

cat > .github/workflows/ci.yml <<'EOF_CI'
name: CI

on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  checks:
    name: Nix flake checks
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - name: Check out repository
        uses: actions/checkout@v5

      - name: Install Nix
        uses: cachix/install-nix-action@v31
        with:
          github_access_token: ${{ secrets.GITHUB_TOKEN }}

      - name: Check working tree whitespace
        run: git diff --check

      - name: Run flake checks
        run: nix flake check --print-build-logs
EOF_CI

cat > modules/phenix-pi/tests/runtime-finalization.test.ts <<'EOF_TEST'
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  childRunId,
  ChildRuntimeError,
  type ChildRun,
  type ContractSubmissionChannel,
} from "../extensions/phenix-runtime/child-session-types.ts";
import { executeProducerCycles } from "../extensions/phenix-subagents/attempt-runner.ts";
import type { HandleRecord } from "../extensions/phenix-subagents/handle-types.ts";
import {
  beginTransition,
  createWorkflowRecord,
  readWorkflowRecord,
} from "../extensions/phenix-workflow/workflow-store.ts";
import { finalizeHandleWorkflow } from "../extensions/phenix-workflow/workflow-runtime.ts";

function temporaryDirectory(prefix: string): string {
  const directory = path.join(
    os.tmpdir(),
    `${prefix}-${randomUUID().slice(0, 8)}`,
  );
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function makeHandle(): HandleRecord {
  const timestamp = new Date().toISOString();
  return {
    version: 4,
    id: "handle-timeout",
    sessionId: "session-timeout",
    modelSet: "test",
    assignment: {
      task: "test timeout ownership",
      requirements: [],
      outputSchema: { type: "object" },
    },
    producerSpec: { criticRequired: false } as HandleRecord["producerSpec"],
    producerCycles: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
  };
}

describe("runtime cancellation ownership", () => {
  it("preserves TIMEOUT after verification and does not start repair", async () => {
    const cwd = temporaryDirectory("phenix-attempt-timeout");
    const controller = new AbortController();
    const record = makeHandle();
    let continued = false;
    let reopened = false;
    let accepted = false;

    const run: ChildRun = {
      id: childRunId("child-timeout"),
      backend: "sdk",
      pi: { sessionId: "pi-timeout" },
      snapshot: () => ({}) as ReturnType<ChildRun["snapshot"]>,
      subscribe: () => () => undefined,
      continue: async () => {
        continued = true;
        return { cycle: 2, status: "settled" };
      },
      waitForCurrentCycle: async () => ({ cycle: 1, status: "settled" }),
      abort: async () => undefined,
      dispose: async () => undefined,
    };

    const channel: ContractSubmissionChannel = {
      current: () => ({
        contractId: "contract-timeout",
        state: "submitted",
        revision: 1,
        outputSchema: { type: "object" },
      }),
      submit: async () => ({ ok: true, state: "submitted", revision: 1 }),
      reopen: async () => {
        reopened = true;
      },
      accept: async () => {
        accepted = true;
      },
      cancel: async () => undefined,
      readSubmitted: async () => ({ value: { done: true }, revision: 1 }),
    };

    const result = await executeProducerCycles({
      run,
      contractChannel: channel,
      contractArtifact: {
        assignment: { outputSchema: { type: "object" } },
      } as never,
      record,
      cwd,
      signal: controller.signal,
      maximumProducerCycles: 2,
      completionGraceRemaining: 0,
      verify: async () => {
        controller.abort(
          new ChildRuntimeError("TIMEOUT", "verification deadline exceeded"),
        );
        return {
          ok: false,
          issues: [{ path: ["verification"], message: "cancelled" }],
          summary: {
            acceptanceStatus: "rejected",
            runtimeChecks: [],
            verifyRuns: ["cancelled"],
            reviewFindings: [],
            contract: "cancelled",
          },
        };
      },
      backend: { kind: "sdk" } as never,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "TIMEOUT");
    assert.equal(record.status, "failed");
    assert.equal(continued, false);
    assert.equal(reopened, false);
    assert.equal(accepted, false);
  });
});

describe("workflow handle finalization", () => {
  it("does not settle a starting handle and accepts a completed handle", () => {
    const cwd = temporaryDirectory("phenix-workflow-finalization");
    const params = {
      instanceId: "instance-finalization",
      actorId: "actor-finalization",
      sessionId: "session-finalization",
      definitionId: "phenix-default" as const,
      difficulty: "D0" as const,
      taskProfile: {
        complexity: 0,
        uncertainty: 0,
        consequence: 0,
        breadth: 0,
        coupling: 0,
        novelty: 0,
      },
      actorRole: "coordinator" as const,
      capabilityArtifactHash: "0".repeat(64),
    };

    const workflow = createWorkflowRecord(cwd, params);
    const begun = beginTransition(cwd, workflow, {
      expectedRevision: workflow.revision,
      transitionId: "d0.execute-base" as never,
      handleId: "handle-finalization",
    });

    const handle = {
      id: "handle-finalization",
      sessionId: params.sessionId,
      status: "starting",
      value: {},
      workflowBinding: {
        instanceId: params.instanceId,
        actorId: params.actorId,
        transitionExecutionId: begun.executionId,
        transitionId: "d0.execute-base",
        sourceState: "classified",
        sourceRevision: 0,
        acceptedState: "completed",
        rejectedState: "failed",
      },
    } as never;

    assert.equal(finalizeHandleWorkflow({ cwd, handle }), undefined);
    assert.equal(
      readWorkflowRecord(cwd, params.instanceId, params.actorId)?.active.length,
      1,
    );

    (handle as { status: string }).status = "completed";
    const finalized = finalizeHandleWorkflow({ cwd, handle });

    assert.ok(finalized);
    assert.equal(finalized.state, "completed");
    assert.equal(finalized.active.length, 0);
    assert.equal(finalized.completed.length, 1);
    assert.equal(finalized.completed[0]?.accepted, true);
  });

  it("throws when a terminal handle references a missing workflow record", () => {
    const cwd = temporaryDirectory("phenix-workflow-missing");
    const handle = {
      id: "missing-workflow-handle",
      sessionId: "missing-session",
      status: "failed",
      workflowBinding: {
        instanceId: "missing-instance",
        actorId: "missing-actor",
        transitionExecutionId: "wfexec-missing",
        transitionId: "d0.execute-base",
        sourceState: "classified",
        sourceRevision: 0,
        acceptedState: "completed",
        rejectedState: "failed",
      },
    } as never;

    assert.throws(
      () => finalizeHandleWorkflow({ cwd, handle }),
      /Workflow record not found while finalizing handle/,
    );
  });
});
EOF_TEST

python3 - <<'PY_MODIFY_NIX'
from pathlib import Path

path = Path("modules/pi-packages.nix")
text = path.read_text()

needle = """      phenixQaTests = pkgs.runCommand \"phenix-qa-tests\" {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.ast-grep
          pkgs.git
        ];
      } ''
        cd ${phenixPiPackage}
        node --experimental-strip-types --test tests/qa-*.test.ts
        touch \"$out\"
      '';
"""

replacement = needle + """

      phenixRepositoryChecks = pkgs.runCommand \"phenix-repository-checks\" {
        nativeBuildInputs = [
          pkgs.bash
          pkgs.shellcheck
        ];
      } ''
        bash -n \\
          ${../scripts/check.sh} \\
          ${../scripts/setup-git-hooks.sh} \\
          ${../.githooks/pre-commit} \\
          ${../.githooks/pre-push}
        shellcheck \\
          ${../scripts/check.sh} \\
          ${../scripts/setup-git-hooks.sh} \\
          ${../.githooks/pre-commit} \\
          ${../.githooks/pre-push}
        touch \"$out\"
      '';
"""

if needle not in text:
    raise SystemExit("could not locate phenixQaTests block")
text = text.replace(needle, replacement, 1)

text = text.replace(
    "        phenix-qa-tests = phenixQaTests;\n        update-pi-npm-hash = updatePiNpmHash;",
    "        phenix-qa-tests = phenixQaTests;\n        phenix-repository-checks = phenixRepositoryChecks;\n        update-pi-npm-hash = updatePiNpmHash;",
    1,
)
text = text.replace(
    "        phenix-qa-tests = phenixQaTests;\n      };",
    "        phenix-qa-tests = phenixQaTests;\n        phenix-repository-checks = phenixRepositoryChecks;\n      };",
    1,
)

path.write_text(text)
PY_MODIFY_NIX

chmod +x scripts/check.sh scripts/setup-git-hooks.sh .githooks/pre-commit .githooks/pre-push
git diff --check
