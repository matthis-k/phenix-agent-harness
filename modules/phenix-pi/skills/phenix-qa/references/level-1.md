# Level 1 — Deterministic Local Code Quality

Measure code complexity, readability risk, and local maintainability using deterministic analyzers.

Prefer language-agnostic or multi-language tools backed by Tree-sitter where practical. Never estimate metrics manually.

## Metric categories

### Complexity

- Cyclomatic complexity.
- Cognitive complexity or a documented approximation.
- NPath or execution-path approximation.
- ABC metrics.
- Halstead metrics.
- Maintainability Index.
- Statement count.
- Logical lines of code.
- Physical lines of code.

### Control flow

- Maximum control-flow nesting depth.
- Number of branches.
- Number of exit points.
- Number of loops.
- Nested loops.
- Nested ternaries.
- Mixed boolean expressions.
- Compound negations.
- Number of boolean terms in conditions.
- Repeated conditional subexpressions.
- Large switch, match, or dispatch structures.

### Function and method structure

- Function length (logical lines).
- Parameter count.
- Local variable count.
- Mutation-site count.
- Number of responsibilities suggested by unrelated dependency groups.
- Number of external symbols referenced.
- Number of distinct state variables modified.
- Number of exception or error exits.

### File and module structure

- File length (logical lines).
- Number of declarations.
- Number of functions and methods.
- Number of exported symbols.
- Public API surface size.
- Complexity concentration (proportion of total file complexity held by the largest functions).

### Type- and boundary-safety indicators

Where relevant to the language:

- Unsafe casts.
- Unchecked deserialization.
- Suppressed type errors (`as any`, `// @ts-ignore`, `#[allow(...)]`).
- Dynamic escape hatches (`eval`, `exec`, `Function()`).
- Null assertions (`!`, `unwrap()` without context).
- Ignored diagnostics.
- Broad exception handlers (`catch (e) {}`, `except: pass`).
- Empty catch blocks.
- Silent error swallowing.
- Unvalidated external input.

## Recommended thresholds

These are review triggers, not universal definitions of bad code:

| Metric | Review | High concern |
|--------|--------|-------------|
| Cyclomatic complexity | 10 | 20 |
| Cognitive complexity | 15 | 30 |
| Max nesting depth | 4 | 6 |
| Boolean terms in condition | 5 | 8 |
| Function logical lines | 50 | 100 |
| File logical lines | 400 | 900 |
| Function parameters | 5 | 8 |

A threshold violation is not automatically a defect. It is evidence requiring interpretation at higher levels.

## Tool discovery

1. Check if the repository has a configured metric tool (e.g., in CI, `package.json` scripts, or Makefile).
2. Look for language-specific tools:
   - TypeScript/JavaScript: `eslint` with complexity rules, `tslint`, `radon` (for JS)
   - Python: `radon`, `wily`, `xenon`
   - Rust: `cargo clippy` (has cognitive complexity lint), `cargo geiger`
   - Go: `gocyclo`, `gocognit`, `golangci-lint`
   - Multi-language Tree-sitter: `codehawk`, `rust-code-analysis`, custom Tree-sitter queries
3. If no tool is available, report the metric analysis as unavailable rather than estimating.

## Report format

- For each tool run: tool name, version, scope analyzed, summary statistics.
- List all threshold violations with location and metric values.
- Do not dump all raw metrics into the main report. Include full output as an artifact reference.
