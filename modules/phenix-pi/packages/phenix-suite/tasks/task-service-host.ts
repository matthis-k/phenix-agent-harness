import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  startTaskRpcServer,
  type TaskRpcServer,
  type TaskRuntimeFacade,
} from "@matthis-k/phenix-tasks/index.ts";

export interface TaskServiceHost {
  endpoint(): Promise<string>;
  close(): Promise<void>;
}

/** Lazily hosts the suite task authority on a private local Unix socket. */
export function createTaskServiceHost(service: TaskRuntimeFacade): TaskServiceHost {
  let directory: string | undefined;
  let serverPromise: Promise<TaskRpcServer> | undefined;

  const ensureServer = (): Promise<TaskRpcServer> => {
    if (serverPromise) return serverPromise;

    const baseDirectory = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
    directory = fs.mkdtempSync(path.join(baseDirectory, "phenix-tasks-"));
    fs.chmodSync(directory, 0o700);
    serverPromise = startTaskRpcServer({
      service,
      socketPath: path.join(directory, "tasks.sock"),
    });
    return serverPromise;
  };

  return {
    async endpoint(): Promise<string> {
      return (await ensureServer()).endpoint;
    },

    async close(): Promise<void> {
      const currentServer = serverPromise;
      serverPromise = undefined;
      try {
        if (currentServer) await (await currentServer).close();
      } finally {
        if (directory) {
          fs.rmSync(directory, { recursive: true, force: true });
          directory = undefined;
        }
      }
    },
  };
}
