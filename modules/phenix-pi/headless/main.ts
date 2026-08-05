import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHeadlessPiHost } from "./host.ts";

export async function runHeadlessPiProcess(): Promise<void> {
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const extensionRoot = process.env.PHENIX_SOURCE_ROOT ?? moduleRoot;
  const host = await createHeadlessPiHost({
    cwd: process.cwd(),
    agentDir: process.env.PI_CODING_AGENT_DIR,
    extensionPaths: [extensionRoot],
    write: writeStdout,
  });

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
