# Security

## Execution permissions

- The root model is read-only and starts substantial work through `phenix_dispatch`.
- Child runs receive an explicit tool set, invokable definitions, limits, and delegation depth.
- Workflow states may invoke only declared definitions.
- Deterministic local checks use structured input and fixed executable arguments.
- A read-only retry cannot gain `edit` or `write`.
- Run and task operations are limited to the current root tree.
- State changes are validated before they are persisted.

Local slash commands are operator actions. They should avoid unsafe defaults, but an operator-selected path or executable is not treated as untrusted remote input.

## Prompts and task data

Task data is schema validated and sent separately from static system instructions. Prompts do not grant tools or permissions.

## Stored data

Run ledgers, diagnostics, and exports may contain repository paths, objectives, summaries, and reduced command descriptions. Files use private permissions. Secret-bearing diagnostic fields are redacted, but agents must not place secrets in objectives, progress messages, or typed results.

## Reporting findings

A security finding should identify the untrusted input, reachable operation, permission crossed, and concrete impact. Do not report an explicit local operator feature as command injection or path traversal unless it crosses a separate permission or confinement limit.
