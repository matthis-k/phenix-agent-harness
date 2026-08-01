# Framework and suite composition

The harness is split into three layers.

## Framework

Framework modules implement mechanisms without selecting Phenix policy:

- `framework/runtime-configuration.ts` defines and validates the catalog and routing dependencies required by runtime assembly.
- `framework/routing/policy-model-resolver.ts` resolves model candidates from an injected inventory and routing policy. It contains no model pools or role routing table.

A framework module must not import from `suite/`.

Framework mechanisms own invariant behavior. They may consume injected policies, adapters, catalogs, schemas, and implementations, but they do not infer lifecycle or dependency order from configuration.

## Phenix suite

The suite is the composition root for concrete behavior:

- `suite/phenix-extension-suite.ts` owns the fixed extension lifecycle and injects concrete registrars.
- `suite/phenix-runtime-configuration.ts` selects agent/workflow definitions, schemas, root capabilities, and the resolver implementation.
- `suite/phenix-routing-policy.ts` owns model pools, allowed providers, role mappings, difficulty routes, and the policy revision.

The extension lifecycle is deterministic code. Configuration remains potent because every registrar is injected as a function and may close over arbitrarily complex typed configuration, adapters, and policies assembled by a custom integration. The suite does not use an ambient service locator or solve a dependency graph at runtime.

Custom integrations should construct a complete configuration or override explicit injected registrars. They should not patch framework internals or reorder lifecycle invariants.

## Host adapters

`extension/phenix.ts` is intentionally thin. It receives Pi's `ExtensionAPI` and installs the configured suite. Runtime assembly receives validated configuration through dependency injection and is unaware of which definitions or routing policy Phenix selected.

## Dependency direction

```text
Pi host -> Phenix suite -> framework/application ports
                   \-> concrete adapters
```

Framework and application code never depend on the Phenix suite. Concrete composition and policy data remain outside the services that interpret them.
