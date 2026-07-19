import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const tracePath = process.env.PHENIX_PI_STREAM_TRACE;
const target = new URL(process.env.PHENIX_PI_STREAM_TRACE_TARGET || "https://opencode.ai/zen/go");
const port = Number(process.env.PHENIX_PI_STREAM_TRACE_PORT || 43119);
if (!tracePath) throw new Error("PHENIX_PI_STREAM_TRACE is required");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const preview = (value, end = false) =>
  JSON.stringify(end ? value.slice(-120) : value.slice(0, 120)).slice(1, -1);
const write = (record) =>
  appendFileSync(
    tracePath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`,
    { mode: 0o600 },
  );
const requests = new Map();

http
  .createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      let payload = {};
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {}
      const traceId = String(incoming.headers["x-phenix-trace-id"] || randomUUID());
      const requestSequence = (requests.get(traceId) || 0) + 1;
      requests.set(traceId, requestSequence);
      const headers = { ...incoming.headers, host: target.host };
      delete headers["x-phenix-trace-id"];
      delete headers["x-phenix-route-attempt"];
      write({
        boundary: "provider_request",
        traceId,
        provider: "opencode-go",
        concreteModel: payload.model,
        apiType: incoming.url?.includes("messages") ? "anthropic-messages" : "openai-completions",
        requestSequence,
        payloadSha256: hash(body),
        messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
        toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
        stream: payload.stream === true,
        routeAttempt: Number(incoming.headers["x-phenix-route-attempt"] || 1),
        retryAttempt: requestSequence,
        requestHost: target.host,
        requestPath: `${target.pathname.replace(/\/$/, "")}${incoming.url}`,
      });
      const upstream = https.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          method: incoming.method,
          path: `${target.pathname.replace(/\/$/, "")}${incoming.url}`,
          headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode || 502, response.headers);
          let buffer = "",
            rawSequence = 0,
            accumulated = "",
            previous = "";
          response.on("data", (chunk) => {
            outgoing.write(chunk);
            buffer += chunk.toString("utf8");
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() || "";
            for (const frame of frames) {
              rawSequence += 1;
              const eventType = frame.match(/^event:\s*(.+)$/m)?.[1] || "message";
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              let parsed;
              try {
                parsed = JSON.parse(data);
              } catch {}
              const choice = parsed?.choices?.[0];
              const content =
                typeof choice?.delta?.content === "string"
                  ? choice.delta.content
                  : typeof parsed?.delta?.text === "string"
                    ? parsed.delta.text
                    : "";
              write({
                boundary: "raw_sse",
                traceId,
                rawSequence,
                sseEventType: eventType,
                providerResponseId: parsed?.id || parsed?.message?.id,
                choiceIndex: choice?.index ?? parsed?.index,
                finishReason: choice?.finish_reason || parsed?.delta?.stop_reason,
                contentLength: content.length,
                contentSha256: hash(content),
                prefixPreview: preview(content),
                suffixPreview: preview(content, true),
                equalsPreviousChunk: content === previous,
                startsWithPreviouslyAccumulated:
                  accumulated.length > 0 && content.startsWith(accumulated),
                previousAccumulatedStartsWithContent:
                  content.length > 0 && accumulated.startsWith(content),
              });
              previous = content;
              accumulated += content;
            }
          });
          response.on("end", () => outgoing.end());
        },
      );
      upstream.on("error", (error) => {
        outgoing.writeHead(502);
        outgoing.end(error.message);
      });
      upstream.end(body);
    });
  })
  .listen(port, "127.0.0.1", () =>
    console.error(`Phenix stream trace proxy listening on http://127.0.0.1:${port}`),
  );
