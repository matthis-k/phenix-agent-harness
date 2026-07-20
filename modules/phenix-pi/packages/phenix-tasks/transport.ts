import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import type {
  TaskAddInput,
  TaskAuthority,
  TaskProgressUpdate,
  TaskRuntimeFacade,
  TaskTreeNode,
  TaskUpdateInput,
  TaskView,
} from "./facade.ts";

export interface BoundTaskClient {
  inspect(): Promise<TaskTreeNode>;
  add(input: TaskAddInput): Promise<TaskView>;
  update(input: TaskUpdateInput): Promise<TaskView>;
  appendLog(input: { readonly uid: string; readonly message: string }): Promise<TaskProgressUpdate>;
}

export type TaskRpcOperation =
  | { readonly method: "inspect" }
  | { readonly method: "add"; readonly params: TaskAddInput }
  | { readonly method: "update"; readonly params: TaskUpdateInput }
  | {
      readonly method: "append_log";
      readonly params: { readonly uid: string; readonly message: string };
    };

export interface TaskRpcRequest {
  readonly id: string;
  readonly capability: string;
  readonly operation: TaskRpcOperation;
}

export type TaskRpcValue = TaskTreeNode | TaskView | TaskProgressUpdate;
export type TaskRpcResponse =
  | { readonly id: string; readonly ok: true; readonly value: TaskRpcValue }
  | { readonly id: string; readonly ok: false; readonly error: string };

export interface TaskRpcServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

function encode(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function socketPathFromEndpoint(endpoint: string): string {
  const normalized = endpoint.trim();
  return normalized.startsWith("unix://") ? normalized.slice("unix://".length) : normalized;
}

function applyOperation(service: TaskRuntimeFacade, request: TaskRpcRequest): TaskRpcValue {
  switch (request.operation.method) {
    case "inspect":
      return service.inspect(request.capability);
    case "add":
      return service.add(request.capability, request.operation.params);
    case "update":
      return service.update(request.capability, request.operation.params);
    case "append_log":
      return service.appendLog(request.capability, request.operation.params);
  }
}

export function createInProcessTaskClient(
  service: TaskRuntimeFacade,
  capability: string,
): BoundTaskClient {
  return {
    async inspect() {
      return service.inspect(capability);
    },
    async add(input) {
      return service.add(capability, input);
    },
    async update(input) {
      return service.update(capability, input);
    },
    async appendLog(input) {
      return service.appendLog(capability, input);
    },
  };
}

export async function startTaskRpcServer(input: {
  readonly service: TaskRuntimeFacade;
  readonly socketPath: string;
}): Promise<TaskRpcServer> {
  if (process.platform !== "win32") {
    try {
      fs.unlinkSync(input.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let request: TaskRpcRequest;
        try {
          request = JSON.parse(line) as TaskRpcRequest;
          const value = applyOperation(input.service, request);
          socket.write(encode({ id: request.id, ok: true, value } satisfies TaskRpcResponse));
        } catch (error) {
          const id = (() => {
            try {
              return (JSON.parse(line) as { id?: string }).id ?? "unknown";
            } catch {
              return "unknown";
            }
          })();
          socket.write(
            encode({
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            } satisfies TaskRpcResponse),
          );
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    endpoint: `unix://${input.socketPath}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (process.platform !== "win32") {
        try {
          fs.unlinkSync(input.socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },
  };
}

export class TaskRpcClient implements BoundTaskClient {
  private readonly socketPath: string;

  constructor(
    endpoint: string,
    private readonly capability: string,
  ) {
    this.socketPath = socketPathFromEndpoint(endpoint);
  }

  inspect(): Promise<TaskTreeNode> {
    return this.request<TaskTreeNode>({ method: "inspect" });
  }

  add(input: TaskAddInput): Promise<TaskView> {
    return this.request<TaskView>({ method: "add", params: input });
  }

  update(input: TaskUpdateInput): Promise<TaskView> {
    return this.request<TaskView>({ method: "update", params: input });
  }

  appendLog(input: {
    readonly uid: string;
    readonly message: string;
  }): Promise<TaskProgressUpdate> {
    return this.request<TaskProgressUpdate>({ method: "append_log", params: input });
  }

  private request<T extends TaskRpcValue>(operation: TaskRpcOperation): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const response = JSON.parse(buffer.slice(0, newline)) as TaskRpcResponse;
        socket.end();
        if (response.id !== id)
          reject(new Error(`Unexpected Phenix task response id: ${response.id}`));
        else if (!response.ok) reject(new Error(response.error));
        else resolve(response.value as T);
      });
      socket.once("connect", () => {
        socket.write(
          encode({ id, capability: this.capability, operation } satisfies TaskRpcRequest),
        );
      });
    });
  }
}

export function taskClientFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TaskRpcClient | undefined {
  const endpoint = environment.PHENIX_TASKS_ENDPOINT?.trim();
  const capability = environment.PHENIX_TASKS_CAPABILITY?.trim();
  return endpoint && capability ? new TaskRpcClient(endpoint, capability) : undefined;
}

export function taskProcessEnvironment(input: {
  readonly endpoint: string;
  readonly authority: TaskAuthority;
}): Readonly<Record<string, string>> {
  return {
    PHENIX_TASKS_ENDPOINT: input.endpoint,
    PHENIX_TASKS_WORKFLOW_ID: input.authority.workflowId,
    PHENIX_TASKS_SCOPE_TASK_ID: input.authority.scopeTaskId,
    PHENIX_TASKS_CAPABILITY: input.authority.token,
  };
}
