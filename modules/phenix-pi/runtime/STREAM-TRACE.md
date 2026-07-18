# Pi provider stream tracing

Tracing is disabled unless `PHENIX_PI_STREAM_TRACE` names an output file outside the repository. Router ingress/egress records are emitted by the extension. Raw provider request/SSE records require the temporary reverse proxy because the Pi 0.80.10 provider SDK transports do not consistently use `globalThis.fetch`.

Start the proxy:

```sh
export PHENIX_PI_STREAM_TRACE=/tmp/phenix-pi-stream.jsonl
export PHENIX_PI_STREAM_TRACE_TARGET=https://opencode.ai/zen/go
node modules/phenix-pi/runtime/stream-trace-proxy.mjs
```

In a temporary copy of the active `models.json`, set only the concrete OpenCode Go model's `baseUrl` to `http://127.0.0.1:43119`, build/run Pi with that model configuration, then reproduce:

```sh
PHENIX_PI_STREAM_TRACE=/tmp/phenix-pi-stream.jsonl \
  pi --model phenix/opencode-go --no-session --tools read -p \
  "Inspect the extensions directory and state in one sentence whether pi-binary-fix exists. Use the read tool once before answering."
```

Run the same command at least three times and repeat with the concrete model selected in the trace and a known-working routed model. Restore the model configuration immediately afterward. The proxy removes `x-phenix-trace-id` and `x-phenix-route-attempt` before forwarding and never records headers, credentials, environment variables, or complete prompts.

Set `PHENIX_PI_STREAM_TRACE_REASONING=1` only when reasoning previews are explicitly required; reasoning previews are otherwise omitted. Delete trace files after analysis and never add them to the repository.
