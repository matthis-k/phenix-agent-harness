# TypeScript policy

Phenix uses TypeScript as a domain-modeling tool, not only as a syntax checker. Internal
protocols should make invalid combinations unrepresentable and require explicit handling when
the repository gains a new capability.

## Composition boundary

`modules/phenix-pi/suite/phenix-runtime-configuration.ts` is the Phenix composition root.
Definitions, schemas, workflow functions, routing, policies, and future internal capabilities are
selected there or by modules imported there.

This is intentionally **not** an external plugin API. Do not add runtime package discovery,
module augmentation, arbitrary third-party registrations, or open string-keyed protocols. Extend
the in-repository configuration and its closed types together. The framework may expose ordinary
ports for dependency inversion, but the concrete Phenix suite owns the complete implementation
set.

## Required modeling patterns

- Represent finite alternatives with literal unions or discriminated unions.
- Make a discriminator determine its corresponding payload. Avoid a tag next to unrelated
  optional fields or `unknown` data.
- Use exhaustive `switch` statements or `satisfies Record<Union, Value>` policy tables when every
  variant needs a decision.
- Return precise result variants from constructors. A function creating a success value should
  return the success member, not the full success/failure union.
- Use branded identifiers and branded units when structurally identical primitives have different
  meanings.
- Represent mutually exclusive fields with separate union members and `never`, rather than several
  independent optional properties.
- Use typestate or capability-bearing handles when an operation is valid only in a particular
  lifecycle state or authority context.
- Derive static types from runtime schemas where possible. Do not maintain a handwritten interface
  separately from the schema that validates it.

## Boundary rule

External values enter as `unknown`: JSON, process output, provider SDK payloads, persisted files,
user input, environment variables, and extension-host values. Parse or validate them once at the
adapter boundary, then expose a concrete domain type internally.

Assertions are allowed only at a narrow boundary where runtime evidence already establishes the
claimed type and the upstream API cannot express that fact. Keep the assertion local and document
the evidence. Do not propagate `unknown`, double assertions, non-null assertions, or generic
records through application and domain layers.

## Enforcement

The repository compiler enables strict checking, exact optional properties, unchecked-index
protection, unknown catch variables, return checking, and switch fallthrough protection. Biome
rejects explicit `any`, non-null assertions, `@ts-ignore`, and non-exhaustive switches over literal
unions.

When a strictness rule exposes existing weak modeling, fix the model or isolate the external
boundary. Do not disable the rule globally or introduce a compatibility shape merely to satisfy the
compiler.
