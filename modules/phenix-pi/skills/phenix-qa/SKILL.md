---
name: phenix-qa
description: Multi-level code quality assurance review covering correctness, metrics, readability, patterns, architecture, system integration, operability, and security. Use for structured QA of changes, modules, or repositories. Produces quality gates, scored risk categories, and actionable findings separated from pre-existing debt.
---

# Phenix QA — Multi-Level Code Quality Assurance

Perform a structured quality-assurance review of the selected codebase or change set. The review assesses quality at multiple levels with clear separation between:

- **Deterministic facts** produced by tools.
- **Repository-specific rule violations**.
- **Reviewer judgments** based on evidence.
- **Problems introduced by the current change** vs. **pre-existing technical debt**.
- **Blocking defects** vs. **advisory improvements**.

## Quick start

1. Resolve the review scope.
2. Run Level 0 checks (parse, build, typecheck, test, lint).
3. Run deterministic metric tools against the scope.
4. Review each higher level in sequence, building on lower-level evidence.
5. Classify each finding as current-change or pre-existing.
6. Produce quality gates, risk scores, and the final report.

Stop only when a lower-level failure prevents meaningful higher-level analysis. Report unavailable analysis explicitly — never treat a missing tool result as a clean result.

## Review scope

Support these scopes. Default to `diff` when reviewing a change:

| Scope | Description |
|-------|-------------|
| `diff` | Changed code relative to a base revision (default). |
| `files` | An explicit list of files. |
| `module` | One module and its direct dependencies. |
| `repository` | The complete repository. |
| `architecture` | Package, module, service, or subsystem boundaries. |

When reviewing a **diff**:

- Analyze changed functions in full.
- Inspect relevant callers and callees.
- Inspect interfaces and contracts affected by the change.
- Compare the implementation with neighboring modules.
- Separate newly introduced issues from pre-existing ones.
- Do not require unrelated historical debt to be fixed.

Resolve the base revision from `git merge-base`, the default branch (e.g., `main` or `master`), or an explicit `--base` argument. When no base is given and the repo is dirty, diff against `HEAD`. When clean, diff against the merge-base of the current branch.

## QA levels

Run the review as a hierarchy of QA levels. Each level builds on evidence from lower levels. Detailed level descriptions and tool guidance are in [references/](references/).

| Level | Name | Focus | Gate |
|-------|------|-------|------|
| 0 | Correctness | Parse, build, typecheck, test, lint, schema validity. | A |
| 1 | Metrics | Deterministic complexity, size, control-flow, and boundary-safety metrics. | B |
| 2 | Readability | Understandability, naming, control-flow clarity, local design. | C |
| 3 | Patterns | Convention consistency across equivalent concepts. | C |
| 4 | Architecture | Dependency direction, layer boundaries, module cohesion. | D |
| 5 | System | System-level correctness: compatibility, retry, concurrency, ordering. | E |
| 6 | Operability | Logging, diagnostics, observability, graceful degradation. | E |
| 7 | Security | Trust boundaries, input validation, auth, injection, secrets. | E |

Full details for each level are in [references/level-0.md](references/level-0.md) through [references/level-7.md](references/level-7.md).

## Review process

Execute in this order:

1. **Resolve scope** — diff base, file list, module boundaries.
2. **Load repository guidance** — read `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/`, architecture docs, package manifests.
3. **Run Level 0 checks** — parse, build, typecheck, test, lint, format-check. Use project-native commands. Level 0 failures are normally blocking.
4. **Run deterministic metric tools** — prefer Tree-sitter-backed analyzers; fall back to language-specific tools. Never estimate metrics manually.
5. **Run structural pattern rules** — use `ast-grep` or equivalent for repository-specific rules.
6. **Build dependency and duplication reports** — dependency graph, clone detection, dead-code analysis.
7. **Gather relevant source context** — read changed files, callers, callees, and neighboring modules.
8. **Review readability and local design** (Level 2) — combine metric evidence with source review.
9. **Review pattern consistency** (Level 3) — identify canonical patterns before claiming deviations.
10. **Review module architecture** (Level 4) — check dependency direction, layer boundaries, cycles.
11. **Review system-level effects** (Level 5) — API compatibility, retry safety, concurrency, partial failure.
12. **Review operational and security concerns** (Levels 6-7) — observability, trust boundaries, injection risks.
13. **Normalize and deduplicate findings** — merge overlapping findings; link each finding to evidence.
14. **Classify current-change vs. existing debt** — tag every finding with `introducedByCurrentChange`.
15. **Produce quality gates, risk scores, and final report**.

Stop only when a lower-level failure prevents meaningful higher-level analysis:

- Parse failure may prevent AST-based metrics.
- Build failure does not prevent architecture review.
- Failing tests do not prevent readability review.

## Evidence and finding contracts

See [contracts/contracts.ts](contracts/contracts.ts) for the full TypeScript type definitions. Every piece of evidence and every finding must conform to these contracts.

### Evidence structure

```ts
interface QaEvidence {
  id: string;
  level: QaLevel;
  source: EvidenceSource;
  tool?: string;
  ruleId?: string;
  category: string;
  message: string;
  locations: SourceLocation[];
  metric?: { name: string; value: number; threshold?: number; unit?: string };
  rawReference?: string;
}
```

### Finding structure

```ts
interface QaFinding {
  id: string;
  level: QaLevel;
  severity: FindingSeverity;       // info | low | medium | high | critical
  confidence: FindingConfidence;   // low | medium | high
  title: string;
  explanation: string;
  evidenceIds: string[];
  locations: SourceLocation[];
  impact: string;
  recommendation: string;
  remediationScope: RemediationScope;
  introducedByCurrentChange: true | false | "unknown";
  blocking: boolean;
}
```

### Finding validation rules

Reject findings that:

- Contain no evidence.
- Are purely stylistic with no maintenance benefit.
- Make architectural claims without repository context.
- Infer deterministic metric values manually.
- Recommend large rewrites without proportionate benefit.
- Repeat another finding without adding information.

## Quality gates

Apply progressive gates. Gates should be configurable by project type.

| Gate | Name | Fail / Review conditions |
|------|------|--------------------------|
| A | Correctness | Fail: does not parse, compile, or type-check; required tests fail; required schemas are invalid. |
| B | Change Safety | Fail or review: high-severity complexity introduced; unsafe boundary handling; dependency cycle; major duplication; coverage drop in high-risk area; unhandled state or protocol cases. |
| C | Design Consistency | Review: change bypasses an established pattern; introduces competing abstraction; mixes responsibilities; expands public API unnecessarily; inconsistent with equivalent modules. |
| D | Architecture | Fail or require exception: dependency direction violated; forbidden layer import; domain/infrastructure/transport/presentation mixed; module responsible for unrelated subsystems; runtime boundary bypassed; new architectural cycle. |
| E | Production Readiness | Fail or require approval: not backward compatible where required; retry/timeout/cancellation unsafe; unhandled data migration; not observable enough to operate; unresolved security or trust-boundary issues. |

Not every repository needs every gate.

## Risk scoring

Produce separate scores (0–100) with confidence. See [references/scoring.md](references/scoring.md) for weighting details.

| Score | Weight (default) |
|-------|------------------|
| Local Complexity Risk | 15% |
| Readability Risk | 10% |
| Pattern Consistency Risk | 10% |
| Architecture Risk | 20% |
| System Integration Risk | 15% |
| Operational Risk | 10% |
| Security Risk | 10% |
| Change Risk | 10% |

Adjust weights by repository type (library weights API compatibility; service weights operability; compiler weights correctness; UI app weights state management).

Do not reduce the complete review to a single number. All component scores and findings must remain visible.

## Change-risk prioritization

Where data is available, combine: complexity, test coverage, churn, recent defect history, dependency fan-in, public API exposure, and number of affected components.

High-priority areas are those that are: complex, frequently changed, poorly tested, widely depended upon, and architecturally central. Do not prioritize stable, isolated code solely because of a high historical metric value.

## Tooling strategy

Prefer existing analyzers over custom metric implementations. The analysis pipeline should support:

| Category | Examples |
|----------|----------|
| Tree-sitter metric analyzer | complexity, size, Halstead, cognitive metrics |
| Structural rule engine | custom repository and pattern rules (e.g., `ast-grep`) |
| Dependency graph analyzer | cycles, fan-in, fan-out, boundary violations |
| Duplicate-code detector | clone blocks and duplication percentages (e.g., `jscpd`) |
| Dead-code analyzer | unused files, symbols, exports, dependencies |
| Coverage analyzer | line, branch, and function coverage |
| Version-control analysis | churn, co-change, ownership, hotspots |
| Security analyzer | language/ecosystem-specific security rules (e.g., `semgrep`) |

Tool names are implementation choices. Normalize their results into the common evidence schema.

## Output format

Produce the final report in this order:

### 1. Executive summary

- Scope reviewed.
- Overall result.
- Blocking issues.
- Highest-risk QA level.
- Whether the architecture remains consistent.
- Whether the current change increases technical debt.
- Analysis coverage and unavailable checks.

### 2. Quality-gate results

```
Gate A — Correctness:        PASS / FAIL / NOT RUN
Gate B — Change Safety:      PASS / REVIEW / FAIL
Gate C — Design Consistency: PASS / REVIEW / FAIL
Gate D — Architecture:       PASS / REVIEW / FAIL
Gate E — Production Readiness: PASS / REVIEW / FAIL
```

### 3. Findings by QA level

For each finding: severity, confidence, location, evidence, why it matters, concrete remediation, whether introduced by current change, whether it blocks approval.

### 4. Deterministic metrics summary

Summarize only important outliers. Include raw machine-readable reports as attachments or referenced artifacts (e.g., `qa-artifacts/metrics.json`).

### 5. Positive observations

Identify patterns worth preserving: clear module boundaries, consistent error handling, good domain predicates, cohesive functions, explicit state transitions, strong tests around high-risk logic.

### 6. Remediation plan

Order remediation by value:

1. Correctness and security.
2. Architecture and system risk.
3. High-risk complexity.
4. Pattern consistency.
5. Readability improvements.
6. Optional cleanup.

Prefer the smallest change that resolves the underlying problem.

## Reviewer rules

The reviewer must:

- Base deterministic claims on tool output.
- Base architectural claims on repository evidence.
- Distinguish facts from judgment.
- Avoid generic best-practice advice.
- Avoid recommending abstractions without a clear boundary.
- Avoid requiring every large function to be split.
- Avoid requiring every repeated block to be generalized.
- Avoid penalizing deliberate language idioms.
- Account for generated code, tests, fixtures, migrations, and declarative files.
- Account for project type and local conventions.
- Prefer proportionate recommendations.
- State when evidence is insufficient.
