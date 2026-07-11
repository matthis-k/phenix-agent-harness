# Level 7 — Security and Trust Boundaries

Identify code-quality issues that create security or integrity risk.

## Inspection points

- Input validation (is all external input validated before use?).
- Output encoding (is output properly encoded for its context — HTML, SQL, shell?).
- Authentication boundaries (are auth checks present at every entry point?).
- Authorization checks (is the principal authorized for the operation?).
- Privilege transitions (are privilege escalations explicit and auditable?).
- Path traversal (are file paths constructed from user input?).
- Command execution (is user input passed to shell or exec?).
- Injection risks: SQL, NoSQL, command, LDAP, XPath, template injection.
- Deserialization of untrusted data.
- Secret exposure (hardcoded secrets, secrets in logs, secrets in error messages).
- Sensitive logging (PII, tokens, passwords in log output).
- Cryptographic misuse: weak algorithms, hardcoded keys, improper IV/nonce, missing authentication.
- Unsafe temporary files (predictable names, world-readable, not cleaned up).
- Dependency trust (known vulnerabilities in dependencies).
- Network-boundary validation (is network input validated?).
- Insecure defaults (is the default configuration secure?).
- Race conditions affecting authorization or integrity (TOCTOU).
- Validation performed after side effects (validate, then act — not act, then validate).
- Confused-deputy scenarios (is a privileged component tricked into misusing its authority?).

## Finding classification

| Classification | Description |
|----------------|-------------|
| Confirmed issue | Reproducible vulnerability with a demonstrated exploit path. |
| High-confidence pattern match | Strong indicator of a vulnerability; manual confirmation recommended. |
| Suspicious construct | Requires manual review; may or may not be exploitable. |
| Defensive improvement | Not a vulnerability, but a hardening opportunity. |

## Constraints

- Do not label generic complexity findings as security vulnerabilities without a credible exploit path.
- Use dedicated static-analysis and security tools where available (e.g., `semgrep`, `CodeQL`, `trivy`, `cargo-audit`, `npm audit`).
- Prefer tool output over manual pattern matching for security findings.
