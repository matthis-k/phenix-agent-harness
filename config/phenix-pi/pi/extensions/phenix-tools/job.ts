/**
 * job tool — background process management for local commands.
 *
 * No shell string by default; command + args only. Output is bounded and persisted.
 * Supports start, status, read, wait, cancel, list operations.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { getState, saveState, nextId, MAX_JOB_OUTPUT_BYTES } from "./_shared.js";
import type { JobRecord } from "./_shared.js";

type JobOp = "start" | "status" | "read" | "wait" | "cancel" | "list";

interface JobParams {
  op: JobOp;
  id?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

// In-memory map of running processes (not persisted)
const runningProcesses = new Map<string, {
  process: ReturnType<typeof spawn>;
  stdoutPath: string;
  stderrPath: string;
  timeout?: ReturnType<typeof setTimeout>;
}>();

export function registerJob(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "job",
    label: "Job",
    description: "Background process management for local commands. Command + args only (no shell string). Output bounded and persisted to state directory.",
    promptSnippet: "Start, monitor, and manage background jobs (builds, tests, checks).",
    promptGuidelines: [
      "Use job for background process management (nix build, flake check, cargo test, npm test, tend).",
      "Commands are specified as command + args array, not shell strings.",
      "Output is bounded to 50KB and persisted to the state directory.",
      "Use job start to launch, job status to check, job read to see output, job wait to block, job cancel to terminate.",
      "Use job list to see all jobs in the current session."
    ],
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("start"),
        Type.Literal("status"),
        Type.Literal("read"),
        Type.Literal("wait"),
        Type.Literal("cancel"),
        Type.Literal("list"),
      ], { description: "Operation" }),
      id: Type.Optional(Type.String({ description: "Job ID (for status/read/wait/cancel)" })),
      command: Type.Optional(Type.String({ description: "Command to run (for start)" })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments (for start)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in ms (default: no timeout)" })),
      maxOutputBytes: Type.Optional(Type.Number({ description: "Max output bytes to capture (default 50KB)" })),
    }),
    async execute(_toolCallId: string, params: JobParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("cancelled");

      const state = getState(ctx);

      switch (params.op) {
        case "start": {
          if (!params.command) {
            return { content: [{ type: "text", text: "command is required for start." }], details: {} };
          }

          const jobId = nextId();
          const jobCwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
          const maxOutput = params.maxOutputBytes ?? MAX_JOB_OUTPUT_BYTES;

          // Create state dir for job output if it doesn't exist
          // Use a temp location for job output files
          const { mkdtempSync } = await import("node:fs");
          const jobDir = mkdtempSync("/tmp/phenix-job-");
          const stdoutPath = resolve(jobDir, "stdout");
          const stderrPath = resolve(jobDir, "stderr");

          const job: JobRecord = {
            id: jobId,
            command: params.command,
            args: params.args ?? [],
            cwd: jobCwd,
            status: "running",
            startTime: Date.now(),
            stdoutFile: stdoutPath,
            stderrFile: stderrPath,
          };

          state.jobs[jobId] = job;
          saveState(ctx);

          // Spawn the process
          const child = spawn(params.command, params.args ?? [], {
            cwd: jobCwd,
            stdio: ["ignore", "pipe", "pipe"],
          });

          // Capture stdout
          let stdoutBuf = Buffer.alloc(0);
          child.stdout.on("data", (chunk: Buffer) => {
            const available = maxOutput - stdoutBuf.length;
            if (available > 0) {
              stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, available)]);
            }
          });

          // Capture stderr
          let stderrBuf = Buffer.alloc(0);
          child.stderr.on("data", (chunk: Buffer) => {
            const available = maxOutput - stderrBuf.length;
            if (available > 0) {
              stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, available)]);
            }
          });

          // Set timeout if specified
          let timeout: ReturnType<typeof setTimeout> | undefined;
          if (params.timeoutMs && params.timeoutMs > 0) {
            timeout = setTimeout(() => {
              child.kill("SIGTERM");
              setTimeout(() => {
                try { child.kill("SIGKILL"); } catch { /* ignore */ }
              }, 2000).unref();
            }, params.timeoutMs).unref();
          }

          runningProcesses.set(jobId, {
            process: child,
            stdoutPath,
            stderrPath,
            timeout,
          });

          child.on("close", async (exitCode) => {
            const running = runningProcesses.get(jobId);
            if (running?.timeout) clearTimeout(running.timeout);

            job.exitCode = exitCode ?? -1;
            job.status = exitCode === 0 ? "done" : "failed";
            job.endTime = Date.now();

            // Write output to files
            try {
              await mkdir(resolve(jobDir), { recursive: true });
              await writeFile(stdoutPath, stdoutBuf.toString("utf8"));
              await writeFile(stderrPath, stderrBuf.toString("utf8"));
            } catch { /* best-effort */ }

            saveState(ctx);
            runningProcesses.delete(jobId);
          });

          child.on("error", () => {
            job.status = "failed";
            job.endTime = Date.now();
            saveState(ctx);
            runningProcesses.delete(jobId);
          });

          return {
            content: [{ type: "text", text: `Started job: ${jobId} — ${params.command} ${(params.args ?? []).join(" ")}` }],
            details: { job },
          };
        }

        case "status": {
          if (!params.id) {
            return { content: [{ type: "text", text: "id is required for status." }], details: {} };
          }

          const job = state.jobs[params.id];
          if (!job) {
            return { content: [{ type: "text", text: `Job not found: ${params.id}` }], details: {} };
          }

          const running = runningProcesses.get(params.id);
          const isRunning = running !== undefined && running.process.exitCode === null;

          const statusLine = `${job.id}: ${job.status} — ${job.command} ${job.args.join(" ")}` +
            `\n  started: ${new Date(job.startTime).toISOString()}` +
            (job.endTime ? `\n  ended: ${new Date(job.endTime).toISOString()}` : "") +
            (job.exitCode !== undefined ? `\n  exit code: ${job.exitCode}` : "");

          return {
            content: [{ type: "text", text: statusLine }],
            details: { job, isRunning },
          };
        }

        case "read": {
          if (!params.id) {
            return { content: [{ type: "text", text: "id is required for read." }], details: {} };
          }

          const job = state.jobs[params.id];
          if (!job) {
            return { content: [{ type: "text", text: `Job not found: ${params.id}` }], details: {} };
          }

          let output = "";
          try {
            if (job.stdoutFile) {
              const stdout = await readFile(job.stdoutFile, "utf8");
              output += stdout.slice(0, MAX_JOB_OUTPUT_BYTES);
              if (stdout.length > MAX_JOB_OUTPUT_BYTES) output += "\n... (stdout truncated)";
            }
            if (job.stderrFile) {
              const stderr = await readFile(job.stderrFile, "utf8");
              if (stderr.length > 0) {
                output += "\n--- stderr ---\n" + stderr.slice(0, MAX_JOB_OUTPUT_BYTES);
                if (stderr.length > MAX_JOB_OUTPUT_BYTES) output += "\n... (stderr truncated)";
              }
            }
          } catch {
            output = "(output file not available yet)";
          }

          return {
            content: [{ type: "text", text: output || "(no output)" }],
            details: { job, output },
          };
        }

        case "wait": {
          if (!params.id) {
            return { content: [{ type: "text", text: "id is required for wait." }], details: {} };
          }

          const job = state.jobs[params.id];
          if (!job) {
            return { content: [{ type: "text", text: `Job not found: ${params.id}` }], details: {} };
          }

          const running = runningProcesses.get(params.id);
          if (!running || running.process.exitCode !== null) {
            return {
              content: [{ type: "text", text: `Job ${params.id} already finished (exit code: ${job.exitCode})` }],
              details: { job, alreadyDone: true },
            };
          }

          // Wait for the process to exit
          await new Promise<void>((resolvePromise) => {
            running.process.on("close", () => resolvePromise());
          });

          return {
            content: [{ type: "text", text: `Job ${params.id} finished (exit code: ${job.exitCode})` }],
            details: { job },
          };
        }

        case "cancel": {
          if (!params.id) {
            return { content: [{ type: "text", text: "id is required for cancel." }], details: {} };
          }

          const running = runningProcesses.get(params.id);
          if (!running) {
            const job = state.jobs[params.id];
            if (job) {
              return {
                content: [{ type: "text", text: `Job ${params.id} is not running (status: ${job.status})` }],
                details: { job },
              };
            }
            return { content: [{ type: "text", text: `Job not found: ${params.id}` }], details: {} };
          }

          running.process.kill("SIGTERM");
          setTimeout(() => {
            try { running.process.kill("SIGKILL"); } catch { /* ignore */ }
          }, 2000).unref();

          return {
            content: [{ type: "text", text: `Cancelled job: ${params.id}` }],
            details: { cancelled: true },
          };
        }

        case "list": {
          const jobs = Object.values(state.jobs);
          if (jobs.length === 0) {
            return { content: [{ type: "text", text: "No jobs in this session." }], details: { jobs: [] } };
          }

          const lines = jobs.map((j) => {
            const isRunning = runningProcesses.has(j.id) && runningProcesses.get(j.id)!.process.exitCode === null;
            const actualStatus = isRunning ? "running" : j.status;
            return `${j.id}: [${actualStatus}] ${j.command} ${j.args.join(" ")}` +
              (j.exitCode !== undefined ? ` (exit: ${j.exitCode})` : "");
          });

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { jobs },
          };
        }

        default:
          return { content: [{ type: "text", text: `Unknown operation: ${params.op}` }], details: {} };
      }
    },
  });
}
