import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { servePhenixAcp } from "./acp-server.ts";
import { createHeadlessPiHost } from "./host.ts";

export async function runHeadlessPiProcess(): Promise<void> {
  if (selectedTransport() === "jsonl") {
    await runJsonlPiProcess();
    return;
  }
  await runAcpPiProcess();
}

export async function runAcpPiProcess(): Promise<void> {
  const host = await createHost(async () => undefined);
  const server = servePhenixAcp(host);
  const signal = waitForTerminationSignal();
  await Promise.race([
    server.closed.then(() => "eof" as const),
    host.shutdownRequested.then(() => "shutdown" as const),
    signal.promise,
  ]);
  signal.dispose();
  server.dispose();
  await host.dispose();
}

export async function runJsonlPiProcess(): Promise<void> {
  const host = await createHost(writeStdout);
  const inputLoop = (async (): Promise<"eof"> => {
    for await (const chunk of process.stdin) {
      await host.server.accept(chunk);
    }
    await host.server.finish();
    return "eof";
  })();

  const signal = waitForTerminationSignal();
  await Promise.race([
    inputLoop,
    host.shutdownRequested.then(() => "shutdown" as const),
    signal.promise,
  ]);
  process.stdin.pause();
  signal.dispose();
  await host.dispose();
}

async function createHost(write: (line: string) => void | Promise<void>) {
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const extensionRoot = process.env.PHENIX_SOURCE_ROOT ?? moduleRoot;
  return createHeadlessPiHost({
    cwd: process.cwd(),
    agentDir: process.env.PI_CODING_AGENT_DIR,
    extensionPaths: [extensionRoot],
    write,
  });
}

function selectedTransport(): "acp" | "jsonl" {
  const argument = process.argv.find((value) => value.startsWith("--transport="));
  const configured = argument?.slice("--transport=".length) ?? process.env.PHENIX_HEADLESS_TRANSPORT;
  return configured === "jsonl" || process.argv.includes("--jsonl") ? "jsonl" : "acp";
}

async function writeStdout(line: string): Promise<void> {
  if (process.stdout.write(line)) return;
  await once(process.stdout, "drain");
}

function waitForTerminationSignal(): {
  readonly promise: Promise<"signal">;
  dispose(): void;
} {
  let resolveSignal: (() => void) | undefined;
  const promise = new Promise<"signal">((resolve) => {
    resolveSignal = () => resolve("signal");
  });
  const onSignal = (): void => resolveSignal?.();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return {
    promise,
    dispose: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHeadlessPiProcess().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
