import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import type {
  PhenixTaskService,
  TaskAuthority,
  TaskMutation,
  TaskNode,
  TaskRecord,
} from "./core.ts";

export interface BoundTaskClient {
  inspect(): Promise<TaskNode>;
  add(input: {
    readonly parentId?: string;
    readonly title: string;
    readonly description?: string;
  }): Promise<TaskRecord>;
  update(input: TaskMutation): Promise<TaskRecord>;
}

export type TaskRpcOperation =
  | { readonly method: "inspect" }
  | {
      readonly method: "add";
      readonly params: {
        readonly parentId?: string;
        readonly title: string;
        readonly description?: string;
      };
    }
  | { readonly method: "update"; readonly params: TaskMutation };

export interface TaskRpcRequest {
  readonly id: string;
  readonly capability: string;
  readonly operation: TaskRpcOperation;
}

export type TaskRpcResponse =
  | { readonly id: string; readonly ok: true; readonly value: TaskNode | TaskRecord }
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
  if (normalized.startsWith("unix://")) return normalized.slice("unix://".length);
  return normalized;
}

function applyOperation(
  service: PhenixTaskService,
  request: TaskRpcRequest,
): TaskNode | TaskRecord {
  switch (request.operation.method) {
    case "inspect":
      return service.inspect(request.capability);
    case "add":
      return service.addTask(request.capability, request.operation.params);
    case "update":
      return service.updateTask(request.capability, request.operation.params);
  }
}

/** Bind the in-process service to one opaque subtree capability. */
export function createInProcessTaskClient(
  service: PhenixTaskService,
  capability: string,
): BoundTaskClient {
  return {
    async inspect(): Promise<TaskNode> {
      return service.inspect(capability);
    },
    async add(input): Promise<TaskRecord> {
      return service.addTask(capability, input);
    },
    async update(input): Promise<TaskRecord> {
      return service.updateTask(capability, input);
    },
  };
}

/**
 * Expose one authoritative task service over a local Unix-domain socket.
 *
 * Child-process backends receive only the endpoint and their opaque subtree
 * capability. They never open the state store directly, so authorization and
 * ordering remain identical to the in-process backend.
 */
export async function startTaskRpcServer(input: {
  readonly service: PhenixTaskService;
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
    async close(): Promise<void> {
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
  private readonly capability: string;

  constructor(endpoint: string, capability: string) {
    this.socketPath = socketPathFromEndpoint(endpoint);
    this.capability = capability;
  }

  inspect(): Promise<TaskNode> {
    return this.request<TaskNode>({ method: "inspect" });
  }

  add(input: {
    readonly parentId?: string;
    readonly title: string;
    readonly description?: string;
  }): Promise<TaskRecord> {
    return this.request<TaskRecord>({ method: "add", params: input });
  }

  update(input: TaskMutation): Promise<TaskRecord> {
    return this.request<TaskRecord>({ method: "update", params: input });
  }

  private request<T extends TaskNode | TaskRecord>(operation: TaskRpcOperation): Promise<T> {
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
        if (response.id !== id) {
          reject(new Error(`Unexpected Phenix task response id: ${response.id}`));
        } else if (!response.ok) {
          reject(new Error(response.error));
        } else {
          resolve(response.value as T);
        }
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
  if (!endpoint || !capability) return undefined;
  return new TaskRpcClient(endpoint, capability);
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
