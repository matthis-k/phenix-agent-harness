---
name: phenix-qa
description: Multi-level code quality assurance review covering correctness, metrics, readability, patterns, architecture, system integration, operability, and security. Use for structured QA of changes, modules, or repositories. Produces quality gates, scored risk categories, and actionable findings separated from pre-existing debt.
---

# Phenix QA — Multi-Level Code Quality Assurance

Perform a structured quality-assurance review of the selected codebase or change set.

## Architecture

The QA system has two layers:

1. **Runtime** (`runtime/`): Deterministic TypeScript modules that own scope resolution, analyzer execution, evidence normalization, report building, gate calculation, risk scoring, and report validation. These run locally and produce machine-readable JSON and human-readable text reports.

2. **Model-assisted review** (this skill): The model interprets deterministic evidence, performs readability/pattern/architecture/system/operability/security review, and submits structured contributions that the runtime validates and merges.

The runtime enforces schemas, validates cross-references (evidence→findings, findings→gates, gates→risk), and rejects malformed model contributions.

## Execution workflow

```
1. Run the QA runtime to produce a deterministic skeleton.
2. Inspect analyzer coverage — note unavailable analyzers.
3. Review deterministic evidence.
4. Perform only the model-assisted levels requested.
5. Submit the model-review contribution using the runtime schema.
6. Let the runtime validate, merge, score, and render the final report.
```

### One-shot review

```bash
node --experimental-strip-types skills/phenix-qa/runtime/index.ts review \
  --scope diff \
  --base main \
  --output qa-results/
```

### Validate a report

```bash
node --experimental-strip-types skills/phenix-qa/runtime/index.ts validate-report report.json
```

### List available analyzers

```bash
node --experimental-strip-types skills/phenix-qa/runtime/index.ts analyzers
```

## Required subsession decomposition for full QA

For a full repository or module QA, the base child is the **review integrator**, not the sole reviewer. Keep unrelated evidence and judgment in separate child contexts. When the corresponding child targets are advertised, delegate these bounded concerns individually:

1. **Scout** — repository topology, module boundaries, test inventory, hotspots, and evidence locations.
2. **Tester** — deterministic QA runtime, project-native checks, code metrics, structural analysis, analyzer coverage, and reproducible command results.
3. **Architect** — dependency direction, facade/implementation boundaries, cohesion, state-machine design, and cross-module coupling.
4. **Critic** — readability, pattern consistency, system integration, operability, security, and challenge of provisional findings.

Use one `phenix_workflow` child execution per concern. Child-local specialist transitions are foreground: collect each handoff before composing the next dependent review. Do not duplicate the same concern in multiple children unless a critic is explicitly challenging another handoff.

The root coordinator must spawn the required base transition only once. A background root spawn returns a handle; while it is active, use `phenix_agent` with that exact handle for `inspect`, `poll`, `await`, `send`, or `cancel`. Never retry the same required transition merely because collection is still in progress.

The base integrator must merge specialist handoffs into the runtime-backed QA contribution, preserve evidence IDs, distinguish unavailable analyzers from clean results, and let the QA runtime calculate gates and risk scores.

## Implemented runtime capability

### Runtime schemas (`contracts/contracts.ts`)

All QA types are now runtime-validatable TypeBox schemas. Validators:

- `validateQaEvidence(value)` — validates evidence items
- `validateQaFinding(value)` — validates findings
- `validateQaReport(value)` — validates full reports
- `assertQaReport(value)` — throws on invalid reports
- `validateModelReviewContribution(value)` — validates model reviewer contributions

Validation rejects: invalid QA levels, empty titles/explanations/impacts/recommendations, risk values outside 0–100, invalid source locations, invalid timestamps, invalid architecture assessments, invalid quality gate values, missing evidence references for model-assisted findings, and blocking on non-high/critical findings.

Semantic validation (`runtime/semantic-validation.ts`) additionally checks: evidence reference integrity, gate reference integrity, risk evidence existence, duplicate IDs, timestamp format, blocking severity constraints, composite score bounds, and remediation reference integrity.

### Analyzer adapters

| Analyzer | Status | Tool | Categories |
|---|---|---|---|
| `project-native` | Available | Discovers package.json verification scripts | build, test, lint, format |
| `metrics` | Available for JavaScript/TypeScript | Packaged FTA 3.0.0 | metrics, cyclomatic complexity, Halstead, maintainability |
| `structural` | Available | ast-grep 0.44.0 | patterns, structural-rules |
| `duplication` | Optional | jscpd (when installed) | duplication, clone-detection |
| `security` | Optional | semgrep (when installed) | security, vulnerability |
| `git-history` | Available | git | version-control, churn, hotspots |

**Required**: `project-native`

**Packaged**: `metrics`, `structural`, `git-history`. The metrics analyzer reports `not-applicable` when FTA finds no supported JavaScript or TypeScript files.

**Optional**: `duplication`, `security` (report as unavailable when not installed; never claim clean results).

### Metrics semantics

FTA parses JavaScript and TypeScript with SWC and returns structured JSON per file. The QA adapter records the complete JSON as a raw artifact and emits compact summary evidence plus files that meet the configured review threshold.

- `cyclo` is reported as cyclomatic complexity: the number of linearly independent control-flow paths, conventionally starting at one and increasing with decision points.
- `fta_score` is FTA's composite maintainability/complexity score; lower is better.
- Halstead volume, difficulty, and effort are retained in threshold-violation evidence.
- `line_count` is the physical line count reported by FTA.

The default cyclomatic review threshold is configured in `runtime/config.ts`. A threshold crossing is evidence for review, not an automatic defect.

### Scope resolution (`runtime/scope.ts`)

Supports: `diff`, `files`, `module`, `repository`, `architecture`.

For `diff` scope:

- Accepts explicit base revision
- Determines merge base against default branch
- Handles dirty worktrees
- Tracks added, modified, renamed, deleted files
- Classifies evidence inside/outside changed lines

### Report pipeline (`runtime/report.ts`)

The runtime:

1. Builds a deterministic skeleton with empty model-review sections
2. Accepts model-review contributions
3. Validates contribution structure
4. Merges model findings with deterministic findings (deduplicates by ID)
5. Recalculates risk scores and composite score in runtime code
6. Recalculates quality gates
7. Runs semantic validation
8. Writes JSON and text reports

### Risk scoring (`runtime/report.ts`)

Scores calculated by runtime code from findings, never estimated by the model:

- Local Complexity Risk (15%)
- Readability Risk (10%)
- Pattern Consistency Risk (10%)
- Architecture Risk (20%)
- System Integration Risk (15%)
- Operational Risk (10%)
- Security Risk (10%)
- Change Risk (10%)

Missing analyzers reduce confidence and increase `unavailableInputs` — they do not lower risk as though code were clean.

### Quality gates

| Gate | Name | Trigger |
|---|---|---|
| A | Correctness | Fail: parse/compile/type-check failure; required tests fail |
| B | Change Safety | Fail/Review: high-severity complexity, unsafe boundaries, dependency cycles |
| C | Design Consistency | Review: pattern deviation, competing abstractions |
| D | Architecture | Fail: dependency direction violation, layer leak, new cycle |
| E | Production Readiness | Fail/Review: backward compatibility, retry safety, observability, security |

### Analysis coverage (`AnalysisCoverage`)

Structured coverage replaces the free-form string:

- Requested, completed, unavailable, and failed analyzers
- Covered vs. total scoped files
- Covered and uncovered languages

### Architecture assessment

Replaced the Boolean `architectureConsistent` with:

```ts
architectureAssessment: "consistent" | "inconsistent" | "uncertain" | "not-reviewed"
```

### Model-assisted review responsibility

The model owns:

| Level | Responsibility |
|---|---|
| Level 2 — Readability | Naming, control-flow clarity, local design |
| Level 3 — Patterns | Convention consistency across equivalent concepts |
| Level 4 — Architecture | Dependency direction, layer boundaries, module cohesion |
| Level 5 — System | API compatibility, retry safety, concurrency, partial failure |
| Level 6 — Operability | Logging, diagnostics, observability, graceful degradation |
| Level 7 — Security | Trust boundaries, input validation, auth, injection, secrets |

All model findings must reference existing evidence IDs. The runtime rejects findings with no evidence.

## Optional analyzer capability

These analyzers are implemented but require tools not currently in the Nix package set:

- **Duplication**: Requires `jscpd` (`npm install -g jscpd`). Reports as unavailable otherwise.
- **Security**: Requires `semgrep` (`pip install semgrep`). Reports as unavailable otherwise.

`metrics`, `git-history`, and `structural` are available in the current Nix environment.

## Future work

- Add deterministic metrics adapters for Rust, QML, Python, Go, and Nix
- Package duplication and security analyzers when their closure and update policy are acceptable
- Add dead-code analysis adapter
- Add dependency graph adapter (e.g., `madge` or `dependency-cruiser`)
- Add coverage analysis adapter
- CI integration — run QA pipeline as a Nix check
- SARIF output support for the report format

## Full QA level details

Detailed review criteria for each level are in `references/level-0.md` through `references/level-7.md`. Quality gate details are in `references/quality-gates.md`. Risk scoring weights and interpretation are in `references/scoring.md`.
