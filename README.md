```sh
nix develop
```

Apply deterministic mechanical fixes:

```sh
maintenance fix
```

Run the complete validation graph:

```sh
maintenance all
```

The flake exposes the generated maintenance provider as `packages.<system>.phenix-maintenance`. The same Nix-declared command tree drives local help/dispatch and CI stage discovery, with explicit source/static, Rust unit, crate/API integration, black-box system, and Nix-installed product/package boundaries.

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for the exact boundaries and focused commands.
