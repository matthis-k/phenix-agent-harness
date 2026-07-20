# Pi provider stream tracing

Tracing is disabled unless `PHENIX_PI_STREAM_TRACE` names an output file outside the repository. The same trace ID now follows one virtual Phenix request through:

1. `phenix_provider_request` — virtual model entry and selected route snapshot;
2. `pi_ingress` — events received from the concrete Pi provider adapter;
3. `router_egress` — events forwarded by the Phenix router;
4. `phenix_provider_egress` — events returned by the virtual `phenix` provider to Pi;
5. `pi_message_update` — Pi's incrementally assembled assistant message;
6. `pi_message_finalized` and `pi_agent_end` — the finalized assistant content.

Records contain event types, sequence numbers, lengths, SHA-256 hashes, bounded text previews, content-block types, route metadata, and terminal state. They never contain credentials, headers, environment values, complete prompts, complete tool arguments, or complete reasoning. Set `PHENIX_PI_STREAM_TRACE_REASONING=1` only when bounded reasoning previews are explicitly required.

Run Pi with a fresh trace file:

```sh
trace_dir="${XDG_STATE_HOME:-$HOME/.local/state}/phenix-pi/traces"
mkdir -p "$trace_dir"
export PHENIX_PI_STREAM_TRACE="$trace_dir/stream-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
pi
```

Compare the duplication-sensitive boundaries:

```sh
jq -c '
  select(
    .boundary == "phenix_provider_request" or
    .boundary == "pi_ingress" or
    .boundary == "router_egress" or
    .boundary == "phenix_provider_egress" or
    .boundary == "pi_message_update" or
    .boundary == "pi_message_finalized" or
    .boundary == "pi_agent_end"
  )
  | {
      traceId,
      boundary,
      routeAttempt,
      ingressSequence,
      egressSequence,
      providerSequence,
      assemblySequence,
      eventType,
      deltaLength,
      deltaSha256,
      partialBlockLength,
      partialBlockSha256,
      visibleTextLength,
      visibleTextSha256,
      selectedProvider,
      selectedModel
    }
' "$PHENIX_PI_STREAM_TRACE"
```

Interpretation:

- duplication already visible in `pi_ingress`: concrete provider or Pi's concrete provider adapter;
- clean `pi_ingress` but duplicated `router_egress`: Phenix routing logic;
- clean `router_egress` but duplicated `phenix_provider_egress`: virtual provider wrapper;
- clean provider egress but duplicated `pi_message_update`: Pi message assembly;
- clean incremental assembly but duplicated `pi_message_finalized`: Pi finalization or persistence.

Raw provider request/SSE records still require the temporary reverse proxy because Pi 0.80.10 provider SDK transports do not consistently use `globalThis.fetch`. Start the proxy only when the new boundaries show duplication already present at `pi_ingress`:

```sh
export PHENIX_PI_STREAM_TRACE_TARGET=https://opencode.ai/zen/go
node modules/phenix-pi/runtime/stream-trace-proxy.mjs
```

In a temporary copy of the active `models.json`, set only the concrete model's `baseUrl` to `http://127.0.0.1:43119`, reproduce, and restore the model configuration immediately afterward. The proxy removes `x-phenix-trace-id` and `x-phenix-route-attempt` before forwarding and never records headers, credentials, environment variables, or complete prompts.

Delete trace files after analysis and never add them to the repository.
