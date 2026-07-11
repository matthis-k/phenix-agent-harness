# Risk Scoring

## Score dimensions

Each score ranges 0–100 with a confidence level. 0 = no risk, 100 = maximum risk.

| Score | What it measures |
|-------|-----------------|
| Local Complexity Risk | Cyclomatic/cognitive complexity concentration, nesting depth, parameter bloat, large functions/files. Informs Gate B. |
| Readability Risk | Naming quality, control-flow clarity, mixed abstraction levels, missing domain predicates. Informs Gate C. |
| Pattern Consistency Risk | Deviation from established conventions where deviation is harmful. Informs Gate C. |
| Architecture Risk | Dependency direction violations, layer leaks, module cohesion, cycles. Informs Gate D. |
| System Integration Risk | Compatibility, retry safety, concurrency, ordering, partial-failure handling. Informs Gate E. |
| Operational Risk | Observability, diagnostics, graceful degradation, secret handling. Informs Gate E. |
| Security Risk | Input validation, injection, auth, trust boundaries, cryptographic misuse. Informs Gate E. |
| Change Risk | Aggregated risk of the current change: combines complexity of changed code, coverage, churn, fan-in, and pre-existing risk scores for affected areas. |

## Default weighting

| Score | Weight |
|-------|--------|
| Local Complexity Risk | 15% |
| Readability Risk | 10% |
| Pattern Consistency Risk | 10% |
| Architecture Risk | 20% |
| System Integration Risk | 15% |
| Operational Risk | 10% |
| Security Risk | 10% |
| Change Risk | 10% |

## Weighting by repository type

Adjust weights based on the repository's primary purpose:

### Library / SDK

| Score | Weight |
|-------|--------|
| Local Complexity Risk | 10% |
| Readability Risk | 10% |
| Pattern Consistency Risk | 10% |
| Architecture Risk | 15% |
| System Integration Risk | 20% |
| Operational Risk | 5% |
| Security Risk | 15% |
| Change Risk | 15% |

Rationale: API compatibility, backward compatibility, and security are paramount. Operability matters less for libraries.

### Service / Application

| Score | Weight |
|-------|--------|
| Local Complexity Risk | 10% |
| Readability Risk | 10% |
| Pattern Consistency Risk | 10% |
| Architecture Risk | 15% |
| System Integration Risk | 15% |
| Operational Risk | 20% |
| Security Risk | 15% |
| Change Risk | 5% |

Rationale: Operability (logging, metrics, graceful degradation, health checks) is critical for services.

### Compiler / Tool

| Score | Weight |
|-------|--------|
| Local Complexity Risk | 15% |
| Readability Risk | 10% |
| Pattern Consistency Risk | 10% |
| Architecture Risk | 20% |
| System Integration Risk | 10% |
| Operational Risk | 10% |
| Security Risk | 10% |
| Change Risk | 15% |

Rationale: Correctness and architecture matter most. Complexity risk is higher due to algorithmic code.

### UI Application

| Score | Weight |
|-------|--------|
| Local Complexity Risk | 15% |
| Readability Risk | 15% |
| Pattern Consistency Risk | 15% |
| Architecture Risk | 15% |
| System Integration Risk | 10% |
| Operational Risk | 10% |
| Security Risk | 10% |
| Change Risk | 10% |

Rationale: State management, component consistency, and readability are top concerns.

### Infrastructure / Platform

| Score | Weight |
|-------|--------|
| Local Complexity Risk | 10% |
| Readability Risk | 10% |
| Pattern Consistency Risk | 10% |
| Architecture Risk | 20% |
| System Integration Risk | 15% |
| Operational Risk | 15% |
| Security Risk | 15% |
| Change Risk | 5% |

Rationale: Architecture and security are critical. Infrastructure code changes less frequently.

## Risk level interpretation

| Score range | Level | Action |
|-------------|-------|--------|
| 0-20 | Low | No action required. |
| 21-40 | Moderate | Monitor; address in regular refactoring cycles. |
| 41-60 | Elevated | Schedule remediation; review at next planning session. |
| 61-80 | High | Remediation strongly recommended before next release. |
| 81-100 | Critical | Remediation required; may block release. |

## Change-risk prioritization

Where data is available, prioritize change risk by combining:

- Complexity of changed code.
- Test coverage of changed code (low coverage = higher risk).
- Churn (frequency of changes to the affected files).
- Recent defect history (bugs fixed in the affected area).
- Dependency fan-in (how many dependents are affected).
- Public API exposure (is the changed code part of the public API?).
- Number of affected components (blast radius).

High-priority areas are generally those that are:

```text
complex
frequently changed
poorly tested
widely depended upon
architecturally central
```

Do not prioritize stable, isolated code solely because it has a high historical metric value.
