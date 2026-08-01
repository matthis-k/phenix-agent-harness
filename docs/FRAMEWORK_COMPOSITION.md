# Framework and suite composition

The harness is split into three layers.

## Framework

Framework modules implement mechanisms without selecting Phenix policy:

- `framework/extension-suite.ts` validates extension modules, resolves their dependency graph, and installs them in deterministic order.
- `framework/runtime-configuration.ts` defines and validates the catalog and routing dependencies required by runtime assembly.
- `framework/routing/policy-model-resolver.ts` resolves model candidates from an injected inventory and routing policy. It contains no model pools or role routing table.

A framework module must not import from `suite/`.

## Phenix suite

The suite is the composition root for concrete behavior:

- `suite/phenix-extension-suite.ts` selects extension modules and their registration dependencies.
- `suite/phenix-runtime-configuration.ts` selects agent/workflow definitions, schemas, root capabilities, and the resolver implementation.
- `suite/phenix-routing-policy.ts` owns model pools, allowed providers, role mappings, difficulty routes, and the policy revision.

Custom integrations should construct a new suite configuration or override explicit extension services. They should not patch framework internals.

## Host adapters

`extension/phenix.ts` is intentionally thin. It receives Pi's `ExtensionAPI` and installs the configured suite. Runtime assembly receives validated configuration through dependency injection and is unaware of which definitions or routing policy Phenix selected.

## Dependency direction

```text
Pi host -> Phenix suite -> framework/application ports
                   \-> concrete adapters
```

Framework and application code never depend on the Phenix suite. Concrete composition and policy data remain outside the services that interpret them.
