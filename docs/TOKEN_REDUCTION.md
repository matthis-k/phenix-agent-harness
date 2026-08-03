# Phenix token reduction

Phenix token reduction is a runtime framework around replaceable output-reduction backends. `TokenReductionService` owns the lifecycle; a backend may prepare a rewritten tool call and recover its complete raw output, but it does not own evidence, model context, or execution authority.

The current backend is `ProcessRtkTokenReductionBackend`. The runtime supplies a Nix-built `phenix-rtk` binary derived from the pinned Nixpkgs `rtk` package. A small source patch makes RTK's private tee complete for Phenix-managed calls, including successful and short output, and prevents truncation while `PHENIX_RTK_LOSSLESS=1` is set.

## Runtime path

```text
bash tool call
  -> TokenReductionService.prepareBash
  -> TokenReductionBackend.prepare
  -> RTK rewrite in a private per-call environment
  -> bash executes the rewritten command
  -> TokenReductionBackend.recover
  -> MemoryService.captureToolResult(raw output)
  -> compact tool result + immutable evidence ID
  -> normal Phenix memory hook (deduplicated)
```

The reduction extension is registered before the memory extension. On completion it imports RTK's raw tee into the root-scoped immutable Phenix evidence store using the original command and tool-call ID. The later generic memory capture sees the same tool-call ID and therefore preserves the raw evidence rather than replacing it with the compact view.

RTK's temporary recovery hint is removed from model-visible output. The replacement receipt reports the backend, raw and reduced byte counts, estimated token savings, and the immutable evidence ID. Exact output is reopened with `phenix_memory action=read evidenceId=<id>` without rerunning the command.

## Failure semantics

Reduction fails open:

- no configured backend: execute the original command;
- unsupported or unchanged rewrite: execute the original command;
- missing RTK binary or rewrite failure: execute the original command;
- ambiguous multiline rewrite: reject the rewrite and execute the original command;
- missing recovery file: keep the compact result, mark it non-lossless, and let normal memory capture persist what was observed;
- explicit `PHENIX_TOKEN_REDUCTION_BACKEND=none` or `RTK_DISABLED=1`: bypass reduction.

A result is marked lossless only after complete raw output has been imported into Phenix memory. Temporary RTK recovery directories are deleted after ingestion or session shutdown.

## Replacement boundary

A future backend implements `TokenReductionBackend`:

- `prepare` returns either passthrough or a rewritten command plus an opaque recovery key;
- `recover` returns complete raw output when available;
- `cleanup` removes backend-owned temporary state.

No backend-specific state appears in the memory repository, model-facing tool contract, or execution ledger.
