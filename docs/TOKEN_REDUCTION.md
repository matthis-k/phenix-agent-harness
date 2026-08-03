# Phenix token reduction

Phenix token reduction is a runtime framework around replaceable output-reduction backends. `TokenReductionService` owns the lifecycle; a backend may prepare a rewritten tool call and recover its complete raw output, but it does not own evidence, model context, or execution authority.

The current backend is `ProcessRtkTokenReductionBackend`. The runtime supplies a Nix-built `phenix-rtk` binary derived from the pinned Nixpkgs `rtk` package. A narrow source patch adds a Phenix-only raw-output sink without changing RTK's ordinary user-facing tee policy.

## Runtime path

```text
single bash command
  -> TokenReductionService.prepareBash
  -> TokenReductionBackend.prepare
  -> RTK rewrite in a private per-call environment
  -> bash executes the rewritten command
  -> backend reads phenix-raw.log
  -> MemoryService.captureToolResult(raw output)
  -> compact tool result + immutable evidence ID
  -> normal Phenix memory hook (deduplicated)
```

The reduction extension is registered after the free-model mutation guard and before the memory extension. The guard therefore evaluates the original command. On completion the reduction service imports `phenix-raw.log` into the root-scoped immutable Phenix evidence store using the original command and tool-call ID. The later generic memory capture sees the same tool-call ID and preserves the raw evidence rather than replacing it with the compact view.

RTK's normal tee is disabled for managed calls. The patched Phenix sink writes one complete, deterministic `phenix-raw.log` in the private per-call directory, including short successful output. After import, the directory is deleted. The model-facing receipt reports the backend, raw and reduced byte counts, estimated token savings, and the immutable evidence ID. Exact output is reopened with `phenix_memory action=read evidenceId=<id>` without rerunning the command.

## Conservative command scope

Only a single shell command is eligible. Commands containing pipelines, chaining, redirection, command substitution, subshells, backgrounding, or newlines pass through unchanged. This restriction avoids pretending that separate RTK subprocess outputs can reconstruct the exact combined shell result.

RTK remains responsible for deciding whether an eligible single command has a useful rewrite. Exit codes `0` and `3` admit a rewrite; unsupported, denied, unchanged, or ambiguous output passes through.

## Failure semantics

Reduction fails open:

- no configured backend: execute the original command;
- compound or shell-composed command: execute the original command;
- unsupported or unchanged rewrite: execute the original command;
- missing RTK binary or rewrite failure: execute the original command;
- ambiguous multiline rewrite: reject the rewrite and execute the original command;
- missing recovery file or failed evidence persistence: keep the compact result and mark it non-lossless;
- explicit `PHENIX_TOKEN_REDUCTION_BACKEND=none`, `RTK_DISABLED=1`, or command-local `RTK_TEE=0`: bypass reduction.

A result is marked lossless only after complete raw output has been imported into Phenix memory. Temporary RTK recovery directories are deleted after ingestion or session shutdown.

## Replacement boundary

A future backend implements `TokenReductionBackend`:

- `prepare` returns either passthrough or a rewritten command plus an opaque recovery key;
- `recover` returns complete raw output when available;
- `cleanup` removes backend-owned temporary state.

No backend-specific state appears in the memory repository, model-facing tool contract, or execution ledger.
