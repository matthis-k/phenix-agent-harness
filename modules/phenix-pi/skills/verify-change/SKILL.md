---
name: verify-change
description: Verify a completed coding change with focused diff inspection, LSP diagnostics, and the repository's native checks. Use before reporting implementation work as complete.
---

# Verify Change

Verify only the work relevant to the current task. Do not expand scope and do not enter an automatic repair loop.

## Procedure

1. Inspect the working tree.

   Use the available shell tool. Prefer `hypa_shell` when present; otherwise use `bash`.

   ```bash
   git status --short
   git diff --stat
   git diff
   ```

2. Identify the files changed for the current task.

   Ignore unrelated pre-existing modifications. Do not revert or modify unrelated user work.

3. Run LSP diagnostics on each changed file supported by a configured language server.

   Use:

   ```text
   lsp_diagnostics({ path: "<changed-file>" })
   ```

   Do not scan the entire repository unless the task explicitly requires it.

4. Run the narrowest authoritative project-native checks.

   Resolve the expected check from the repository before inventing a new command. Inspect, in order:

   * `AGENTS.md` or repository instructions
   * `flake.nix` and flake checks
   * `package.json` scripts
   * `Cargo.toml`
   * `pyproject.toml`
   * `Makefile`, `justfile`, `Taskfile`, or equivalent
   * existing CI definitions

   Examples include:

   ```bash
   cargo clippy
   cargo test
   npm test
   npm run check
   nix flake check
   python -m pytest
   ```

   These are examples, not commands that must all be run.

5. Reinspect the final diff after checks.

   Confirm:

   * the requested behavior is implemented;
   * no unrelated files were changed;
   * no generated or cache files were accidentally added;
   * diagnostics and checks are either passing or explicitly reported;
   * the implementation is no broader than necessary.

6. Report verification evidence.

   Include:

   * changed files;
   * LSP diagnostic results;
   * commands run;
   * pass, fail, or not-run status;
   * unresolved problems;
   * any checks that could not be run and the concrete reason.

## Constraints

* Do not commit or push unless explicitly requested.
* Do not hide failed diagnostics.
* Do not repeatedly repair and re-run without a bounded reason.
* Do not treat warnings as fatal unless the repository does.
* Do not format or rewrite unrelated code.
* Do not claim a check passed when it was not run.
