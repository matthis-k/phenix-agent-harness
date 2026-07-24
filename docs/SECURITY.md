# Security and trust boundaries

## Principals

Phenix distinguishes three relevant authorities:

1. The local operator, who already owns the Pi process and repository permissions.
2. The root/frontend model, which is read-only and may start substantial work only through `phenix_dispatch`.
3. Child agents and workflow process managers, which receive compiled tools and capabilities for one run.

An explicit local slash command is not a remote privilege boundary. It should still avoid accidental interpretation and unsafe defaults, but operator-selected destinations and programs are intentional local authority.

## Enforced boundaries

- Root execution is limited by an explicit invokable-definition allowlist.
- Child invocation is limited by compiled capabilities and delegation depth.
- Workflow children require trusted workflow causation.
- Local deterministic checks use structured specifications and fixed argv execution.
- Read-only recovery cannot gain edit/write tools.
- Task and run operations enforce root or descendant scope.
- State commits validate transitions against a staged projection.
- Durable telemetry excludes raw tool output and minimizes command data.

## Prompt handling

Task data is schema-validated and sent in the task message. It is not interpolated into static system instructions. Prompt language is never treated as authorization; concrete tools, capabilities, and application checks remain authoritative.

## Persistence

Run ledgers and fact exports may contain repository paths, typed objectives, summaries, and reduced command descriptions. Ledger files and fact exports use private permissions. Observability redaction is defense-in-depth; agents must not deliberately place secrets in objectives, progress messages, or typed outputs.

## Reporting findings

A security finding should identify:

- the untrusted principal,
- the input path,
- the privilege or invariant crossed,
- the reachable sink,
- and the resulting impact.

Do not classify an explicit local operator feature as command injection or path traversal unless it crosses a separate privilege or confinement boundary.
