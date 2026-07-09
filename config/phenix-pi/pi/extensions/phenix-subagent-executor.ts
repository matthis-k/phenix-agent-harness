/**
 * phenix-subagent-executor.ts — Real Subagent Execution Runtime
 *
 * Runs subagents as isolated child `pi` processes, NOT as direct model API calls.
 *
 * Architecture:
 *   parent pi process
 *     └─ spawn child pi process (--mode json -p --no-session)
 *         └─ child has own runtime loop, own active tool set
 *         └─ child receives bounded prompt/context via stdin + append-system-prompt
 *         └─ parent receives compact final output + structured metadata
 *         └─ parent does NOT ingest child's full tool transcript
 *
 * Compare with @mjakl/pi-subagent approach which also uses child processes.
 * This implementation is a minimal Phenix-native subset:
 * *   - Parallel execution via runPhenixSubagentsParallel
 * *   - Async inter-subagent communications via SubagentCommChannel
 *   - Config directory passthrough so child pi runs with same extensions/agents/prompts as parent
 *   - No fork mode (spawn-only)
 *   - No runtime tool enforcement (Pi extension API limitation)
 *   - No agent discovery from .md files (Phenix agents are defined in pi/agents/)
 *
 * Safety:
 *   - NO imports from pi-ai/compat (no direct model streaming) (no direct model streaming)
 *   - ctx.modelRegistry key resolution is used ONLY for child env propagation
 *     to propagate keys to the child process environment — NOT for direct streaming
 *   - Recursion prevention via PI_SUBAGENT_DEPTH env var
 *   - Output caps (max bytes, max lines)
 *   - Timeout-based process termination
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ══════════════════════════════════════════════
// 1. PUBLIC TYPES
// ══════════════════════════════════════════════

export type PhenixSubagentRole =
  | "scout"
  | "planner"
  | "architect"
  | "worker"
  | "verifier"
  | "reviewer"
  | "debugger";

export interface RunPhenixSubagentInput {
  role: PhenixSubagentRole;
  task: string;
  cwd: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools?: string[];
  initialContext?: "empty" | "parent-minimal";
  session?: string | null;
  maxBytes?: number;
  maxLines?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface RunPhenixSubagentResult {
  status: "done" | "failed" | "timeout" | "cancelled";
  role: PhenixSubagentRole;
  modelUsed: string | null;
  cwd: string;
  summary: string;
  text: string;
  bytes: number;
  lines: number;
  truncated: boolean;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  error?: string;
  details?: Record<string, unknown>;
}

// ══════════════════════════════════════════════
// 2. OLD-TYPE COMPAT ALIASES
// ══════════════════════════════════════════════

export type Difficulty = "D0" | "D1" | "D2" | "D3";

export type SubagentRole = PhenixSubagentRole;

export type SubagentProfile =
  | "repo_scout"
  | "implementation"
  | "refactor"
  | "test_author"
  | "verifier_patch"
  | "safety_io";

export type SubagentStatus = "done" | "failed" | "blocked";

export type ToolEnforceability = "runtime_enforced" | "prompt_only" | "unavailable";

export interface ToolPolicy {
  allowedTools: string[];
  deniedTools: string[];
  enforceable: ToolEnforceability;
}

export interface SubagentPermissions {
  read: boolean;
  edit: boolean;
  shell: "none" | "read_only" | "safe" | "unrestricted";
  network: boolean;
  canDelegate: boolean;
  canAskUser: boolean;
}

export interface ModelSet {
  provider: string;
  model: string;
}

export interface ContextPack {
  relevantFiles: Array<{ path: string; lines: string; content?: string }>;
  relevantSymbols: Array<{ name: string; location: string }>;
  projectStructure?: string;
  userPrompt: string;
  taskBrief: string;
  parentPublicCard?: string;
  inheritedDecisions: string[];
}

export interface SubagentRunRequest {
  sessionId: string;
  parentTaskId: string | null;
  taskId: string;
  role: SubagentRole;
  profile: SubagentProfile;
  modelSet: ModelSet;
  difficulty: Difficulty;
  taskBrief: string;
  contextPack: ContextPack;
  outputSchema: string;
  permissions: SubagentPermissions;
  toolPolicy: ToolPolicy;
  maxTurns: number;
  maxToolCalls: number;
  maxOutputTokens: number;
}

export interface SubagentRunResult {
  taskId: string;
  status: SubagentStatus;
  report: SubagentReport;
  publicCard: SubagentPublicCard;
  artifactRefs: string[];
  rawResultRef?: string;
  toolPolicyEnforced: ToolEnforceability;
  turnsUsed: number;
  modelUsed: string;
}

export interface SubagentReport {
  type: "discovery" | "done" | "blocker" | "scope_issue" | "verification" | "safety_risk";
  summary: string;
  body: Record<string, unknown>;
  evidenceRefs: string[];
}

export interface SubagentPublicCard {
  taskId: string;
  status: string;
  summary: string;
  currentFocus: string | null;
  latestReportRef: string | null;
}

export interface EvidencePacket {
  summary: string;
  relevantFiles: Array<{ path: string; lines: string; reason: string }>;
  symbols: Array<{ name: string; location: string; reason: string }>;
  currentBehavior: string | null;
  likelyEditPoints: Array<{ path: string; reason: string }>;
  risks: string[];
  confidence: "low" | "medium" | "high";
}

export interface VerificationReport {
  status: "pass" | "fail";
  failures: Array<{ issue: string; evidence: string; ownerHint: string | null; requiredFix: string }>;
  checks: Array<{ command: string; result: "pass" | "fail" | "not_run" }>;
  scopeViolations: string[];
}

export interface PatchReport {
  summary: string;
  filesChanged: Array<{ path: string; reason: string }>;
  interfaceChanges: string[];
  checksRun: Array<{ command: string; result: "pass" | "fail" | "not_run" }>;
  unresolvedIssues: string[];
  artifactRefs: string[];
}

// ══════════════════════════════════════════════
// 3. CONSTANTS
// ══════════════════════════════════════════════

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export const PARALLEL_DEFAULTS = {
  enabled: true,
  maxConcurrency: 4,
  maxTotalSubagents: 8,
  commTimeoutMs: 30_000,
};

export const COMM_CHANNEL_DEFAULTS = {
  dirName: ".phenix-subagent-comm",
  filePrefix: "comm-",
  resultFilePrefix: "result-",
  maxAgeMs: 120_000,
};

const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";

/**
 * Default tool sets per role.
 *
 * IMPORTANT: Pi extension API does NOT enforce tool filtering per-agent turn.
 * These are advisory (prompt-level instructions), NOT runtime enforcement.
 * The child Pi process receives the agent markdown which lists available tools,
 * but nothing prevents the child from calling tools outside the allowlist.
 */
export const ROLE_TOOL_DEFAULTS: Record<PhenixSubagentRole, string[]> = {
  scout: ["read", "find", "search", "grep", "ls", "lsp"],
  planner: ["read", "find", "search", "grep", "ls", "lsp"],
  architect: ["read", "find", "search", "grep", "ls", "lsp"],
  worker: ["read", "find", "search", "grep", "ls", "lsp", "edit", "ast_grep", "ast_edit", "bash"],
  verifier: ["read", "find", "search", "grep", "ls", "lsp", "bash"],
  reviewer: ["read", "find", "search", "grep", "ls", "lsp"],
  debugger: ["read", "find", "search", "grep", "ls", "lsp", "bash"],
};

// ══════════════════════════════════════════════
// 4. SHOULD-RUN-SCOUT LOGIC
// ══════════════════════════════════════════════

export function shouldRunRepoScout(input: {
  difficulty: Difficulty;
  prompt: string;
  exactPathsMentioned: string[];
  exactSymbolsMentioned: string[];
}): boolean {
  const lower = input.prompt.toLowerCase();

  if (input.difficulty === "D0") {
    const isMechanicalTypo = /\b(typo|format|rename|spelling|trivial)\b/i.test(lower);
    const hasExactPath = input.exactPathsMentioned.length > 0;
    if (isMechanicalTypo && hasExactPath) return false;
    return false;
  }

  const sensitiveKeywords = /\b(workflow|routing|mcp|nix|rust|test|config|architect|depend|security|auth)\b/i;
  if (sensitiveKeywords.test(lower)) return true;

  if (input.difficulty === "D1" || input.difficulty === "D2" || input.difficulty === "D3") return true;

  return false;
}

// ══════════════════════════════════════════════
// 5. PROFILE & MODEL MAPS
// ══════════════════════════════════════════════

export const SUBAGENT_PROFILES: Record<SubagentProfile, {
  role: SubagentRole;
  permissions: SubagentPermissions;
  toolPolicy: ToolPolicy;
  outputSchema: string;
  maxTurnsDefault: number;
  maxToolCallsDefault: number;
  maxOutputTokensDefault: number;
}> = {
  repo_scout: {
    role: "scout",
    permissions: { read: true, edit: false, shell: "read_only", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["find", "search", "read", "lsp", "grep", "ls"],
      deniedTools: ["edit", "write", "resolve", "bash", "job", "task", "todo"],
      enforceable: "prompt_only",
    },
    outputSchema: "EvidencePacket",
    maxTurnsDefault: 1,
    maxToolCallsDefault: 10,
    maxOutputTokensDefault: 4096,
  },
  implementation: {
    role: "worker",
    permissions: { read: true, edit: true, shell: "safe", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["read", "search", "edit", "find", "grep", "ast_grep", "ast_edit", "bash"],
      deniedTools: ["commit", "push", "deploy", "network"],
      enforceable: "prompt_only",
    },
    outputSchema: "PatchReport",
    maxTurnsDefault: 3,
    maxToolCallsDefault: 20,
    maxOutputTokensDefault: 8192,
  },
  refactor: {
    role: "worker",
    permissions: { read: true, edit: true, shell: "safe", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["read", "search", "ast_grep", "ast_edit", "lsp", "find"],
      deniedTools: ["commit", "push", "edit"],
      enforceable: "prompt_only",
    },
    outputSchema: "PatchReport",
    maxTurnsDefault: 3,
    maxToolCallsDefault: 20,
    maxOutputTokensDefault: 8192,
  },
  test_author: {
    role: "worker",
    permissions: { read: true, edit: true, shell: "safe", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["read", "search", "edit", "bash", "find"],
      deniedTools: ["commit", "push"],
      enforceable: "prompt_only",
    },
    outputSchema: "PatchReport",
    maxTurnsDefault: 3,
    maxToolCallsDefault: 20,
    maxOutputTokensDefault: 8192,
  },
  verifier_patch: {
    role: "verifier",
    permissions: { read: true, edit: false, shell: "safe", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["read", "diff", "bash", "lsp", "search", "find"],
      deniedTools: ["edit", "write", "resolve", "commit", "push"],
      enforceable: "prompt_only",
    },
    outputSchema: "VerificationReport",
    maxTurnsDefault: 1,
    maxToolCallsDefault: 10,
    maxOutputTokensDefault: 4096,
  },
  safety_io: {
    role: "safety_reviewer",
    permissions: { read: true, edit: false, shell: "read_only", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["read", "search", "diff", "find"],
      deniedTools: ["edit", "write", "resolve", "bash", "commit", "push"],
      enforceable: "prompt_only",
    },
    outputSchema: "VerificationReport",
    maxTurnsDefault: 1,
    maxToolCallsDefault: 5,
    maxOutputTokensDefault: 4096,
  },
};

export const RECURSION_DEFAULTS = {
  enabled: true,
  maxDepth: 2,
  maxChildrenPerTask: 4,
  maxTotalSubagents: 8,
  maxTurnsPerSubagent: {
    repo_scout: 1,
    implementation: 3,
    refactor: 3,
    test_author: 3,
    verifier_patch: 1,
    safety_io: 1,
  } as Record<SubagentProfile, number>,
  maxToolCallsPerSubagent: {
    repo_scout: 10,
    implementation: 20,
    refactor: 20,
    test_author: 20,
    verifier_patch: 10,
    safety_io: 5,
  } as Record<SubagentProfile, number>,
};

export const AGENT_COMM_MCP_OPS = [
  "comm_task_create",
  "comm_task_update",
  "comm_task_complete",
  "comm_task_block",
  "comm_message_send",
  "comm_artifact_record",
  "comm_graph_create",
  "comm_graph_get",
  "comm_graph_summary",
] as const;

// ══════════════════════════════════════════════
// 6. MODEL RESOLVER
// ══════════════════════════════════════════════

const DEFAULT_SUBAGENT_MODELS: Record<string, Record<string, ModelSet>> = {
  "phenix/free": {
    scout: { provider: "opencode", model: "deepseek-v4-flash-free" },
    worker: { provider: "opencode", model: "deepseek-v4-flash-free" },
    verifier: { provider: "opencode", model: "deepseek-v4-flash-free" },
    default: { provider: "opencode", model: "deepseek-v4-flash-free" },
  },
  "phenix/mixed": {
    scout: { provider: "opencode", model: "deepseek-v4-flash-free" },
    worker: { provider: "opencode", model: "deepseek-v4-flash-free" },
    verifier: { provider: "openai", model: "gpt-5.5" },
    default: { provider: "opencode", model: "deepseek-v4-flash-free" },
  },
  "phenix/opencode-go": {
    scout: { provider: "opencode", model: "deepseek-v4-flash" },
    worker: { provider: "opencode", model: "deepseek-v4-flash" },
    verifier: { provider: "opencode", model: "deepseek-v4-flash" },
    default: { provider: "opencode", model: "deepseek-v4-flash" },
  },
  "phenix/gpt": {
    scout: { provider: "openai", model: "gpt-5.5" },
    worker: { provider: "openai", model: "gpt-5.5" },
    verifier: { provider: "openai", model: "gpt-5.5" },
    default: { provider: "openai", model: "gpt-5.5" },
  },
};

export function resolveSubagentModel(
  frontendModelSet: string,
  role: SubagentRole,
  _difficulty: Difficulty,
  _ctx: ExtensionContext,
): { modelSet: ModelSet; available: boolean } {
  const slots = DEFAULT_SUBAGENT_MODELS[frontendModelSet];
  if (!slots) {
    const fallback = DEFAULT_SUBAGENT_MODELS["phenix/free"];
    return { modelSet: fallback[role] ?? fallback.default, available: true };
  }
  return { modelSet: slots[role] ?? slots.default, available: true };
}

export function detectFrontendModelSet(ctx: ExtensionContext): string {
  const model = ctx.model;
  if (!model) return "phenix/free";

  const id = model.id;
  const provider = model.provider;

  if (provider === "phenix") {
    if (id === "free") return "phenix/free";
    if (id === "mixed") return "phenix/mixed";
    if (id === "opencode-go") return "phenix/opencode-go";
    if (id === "gpt") return "phenix/gpt";
    return `phenix/${id}`;
  }

  if (provider === "openai" || provider === "anthropic") return "phenix/gpt";
  if (provider === "opencode") return "phenix/opencode-go";

  return "phenix/free";
}

/**
 * Resolve the concrete model string to pass to the child pi process.
 */
export function resolveRoleModel(
  frontendMode: string,
  role: PhenixSubagentRole,
  _difficulty: Difficulty,
): string {
  const modelSetKey = frontendMode === "phenix/free" ? "phenix/free"
    : frontendMode === "phenix/opencode-go" ? "phenix/opencode-go"
    : frontendMode === "phenix/gpt" ? "phenix/gpt"
    : frontendMode === "phenix/mixed" ? "phenix/mixed"
    : "phenix/free";

  const slots = DEFAULT_SUBAGENT_MODELS[modelSetKey];
  if (!slots) return "opencode/deepseek-v4-flash-free";

  const ms = slots[role] ?? slots.default;
  return `${ms.provider}/${ms.model}`;
}

// ══════════════════════════════════════════════
// 7. PI BINARY RESOLUTION
// ══════════════════════════════════════════════

interface PiCommand {
  command: string;
  args: string[];
}

/**
 * Resolve the `pi` binary command for child process spawning.
 *
 * In the Nix wrapper, `pi` is on PATH. In dev mode (node + tsx),
 * we use node + the pi script. This matches the approach used by
 * @mjakl/pi-subagent.
 */
function resolvePiCommand(): PiCommand {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, args: [process.argv[1]] };
  }
  return { command: "pi", args: [] };
}

// ══════════════════════════════════════════════
// 8. THE REAL SUBAGENT: CHILD PI PROCESS
// ══════════════════════════════════════════════

/**
 * Run a subagent as a child `pi` process.
 *
 * This is the core primitive. It spawns a real `pi` process with:
 *   --mode json -p --no-session
 *   --model <resolved model>
 *   --tools <role-specific tools>
 *   (optional --thinking, --append-system-prompt)
 *
 * The child process has its own runtime loop, tool set, and model.
 * The parent receives only the compact final output + metadata.
 *
 * IMPORTANT: This function does NOT call any direct model APIs.
 * It spawns a real child `pi` process.
 */
export async function runPhenixSubagent(
  input: RunPhenixSubagentInput,
  ctx: ExtensionContext,
): Promise<RunPhenixSubagentResult> {
  const startedAt = new Date().toISOString();
  const role = input.role;
  const task = input.task;
  const cwd = input.cwd || ctx.cwd;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = input.maxLines ?? DEFAULT_MAX_LINES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Resolve model
  const frontendModel = detectFrontendModelSet(ctx);
  const modelStr = input.model ?? resolveRoleModel(frontendModel, role, "D1");

  // Resolve tools
  const tools = input.tools ?? ROLE_TOOL_DEFAULTS[role];

  // Check recursion guard
  const currentDepth = parseInt(process.env[SUBAGENT_DEPTH_ENV] ?? "0", 10);
  if (currentDepth >= RECURSION_DEFAULTS.maxDepth) {
    return {
      status: "failed",
      role,
      modelUsed: modelStr,
      cwd,
      summary: `Subagent depth limit reached (${currentDepth} >= ${RECURSION_DEFAULTS.maxDepth}). Recursive subagents blocked.`,
      text: "",
      bytes: 0,
      lines: 0,
      truncated: false,
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: null,
      error: `Recursion guard: depth ${currentDepth} >= max ${RECURSION_DEFAULTS.maxDepth}`,
      details: { depth: currentDepth, maxDepth: RECURSION_DEFAULTS.maxDepth, blockedBy: "recursion_guard" },
    };
  }

  // Determine pi binary
  const piCommand = resolvePiCommand();

  // Build pi CLI args
  const piArgs: string[] = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--model", modelStr,
    "--tools", tools.join(","),
  ];

  if (input.thinking) {
    piArgs.push("--thinking", input.thinking);
  }

  // Append system prompt from agent file if available
  const agentFile = findAgentFile(role, cwd);
  if (agentFile) {
    piArgs.push("--append-system-prompt", agentFile);
  }

  // The prompt content is passed as the positional arg
  piArgs.push(task);

  // Build environment with recursion guard
  // Build environment with recursion guard and config passthrough
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    [SUBAGENT_DEPTH_ENV]: String(currentDepth + 1),
    PI_OFFLINE: "1",
  };

  // Pass the parent config directory so child pi loads same extensions/agents/prompts/themes
  if (process.env.PI_CODING_AGENT_DIR) {
    env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
  }
  if (process.env.PI_DIR) {
    env.PI_DIR = process.env.PI_DIR;
  }

  // Set model API keys for the child (resolved through parent ctx)
  try {
    const modelConfig = resolveRoleModel(frontendModel, role, "D1");
    const [provider, modelName] = modelConfig.split("/");
    const concreteModel = ctx.modelRegistry?.find(provider, modelName);
    if (concreteModel) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(concreteModel);
      if (auth.ok && auth.apiKey) {
        env.PI_API_KEY = auth.apiKey;
      }
    }
  } catch {
    // Best-effort — child pi will use its own API key discovery
  }

  // Spawn child process
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;
  let cancelled = false;

  try {
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    }>((resolve, reject) => {
      const proc = spawn(
        piCommand.command,
        [...piCommand.args, ...piArgs],
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env,
          shell: false,
        },
      );

      let stdoutBuf = "";
      let stderrBuf = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        }, 3000);
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        resolve({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: code,
          timedOut,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      // Handle cancellation via metadata
      if (input.metadata?.cancel?.valueOf()) {
        cancelled = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        }, 1000);
      }
    });

    exitCode = result.exitCode;
    stdout = result.stdout;
    stderr = result.stderr;
    timedOut = result.timedOut;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      role,
      modelUsed: modelStr,
      cwd,
      summary: `Subagent process error: ${errMsg}`,
      text: "",
      bytes: 0,
      lines: 0,
      truncated: false,
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: null,
      error: errMsg,
    };
  }

  // Parse JSON-mode output
  const { cleanedText, modelUsed, truncated, lines: lineCount } = parsePiJsonOutput(
    stdout,
    maxBytes,
    maxLines,
  );

  // Determine status
  let status: "done" | "failed" | "timeout" | "cancelled";
  if (cancelled) {
    status = "cancelled";
  } else if (timedOut) {
    status = "timeout";
  } else if (exitCode === 0 && cleanedText.trim().length > 0) {
    status = "done";
  } else {
    status = "failed";
  }

  const summary = cleanedText.trim().split("\n")[0]?.slice(0, 200) ?? stderr.slice(0, 200) ?? "(no output)";

  const endedAt = new Date().toISOString();
  const byteCount = Buffer.byteLength(cleanedText, "utf-8");

  return {
    status,
    role,
    modelUsed: modelUsed ?? modelStr,
    cwd,
    summary,
    text: cleanedText,
    bytes: byteCount,
    lines: lineCount,
    truncated,
    startedAt,
    endedAt,
    exitCode,
    error: stderr.trim() || undefined,
    details: {
      rawExitCode: exitCode,
      stderrSize: stderr.length,
      timedOut,
    },
  };
}

// ══════════════════════════════════════════════
// 9. JSON OUTPUT PARSER
// ══════════════════════════════════════════════

export interface PiJsonOutput {
  cleanedText: string;
  modelUsed: string | null;
  truncated: boolean;
  lines: number;
}

/**
 * Parse Pi's JSON-mode output.
 *
 * Pi in --mode json produces JSONL events on stdout:
 *   {"type":"start","partial":{...}}
 *   {"type":"chunk","delta":{...}}
 *   {"type":"end","result":{...}}
 *
 * We collect assistant final text from the events and ignore tool-call details.
 */
export function parsePiJsonOutput(
  raw: string,
  maxBytes: number,
  maxLines: number,
): PiJsonOutput {
  let cleanedText = "";
  let modelUsed: string | null = null;
  let lines = 0;
  let truncated = false;

  const lines_arr = raw.split("\n");
  for (const line of lines_arr) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        if (parsed.type === "end" && parsed.result) {
          const result = parsed.result;
          if (result.content) {
            if (Array.isArray(result.content)) {
              for (const c of result.content) {
                if (c.type === "text") cleanedText += c.text;
              }
            } else if (typeof result.content === "string") {
              cleanedText += result.content;
            }
          }
          if (result.model) modelUsed = result.model;
        } else if (parsed.type === "start" && parsed.partial) {
          const partial = parsed.partial;
          if (partial.content && Array.isArray(partial.content)) {
            for (const c of partial.content) {
              if (c.type === "text") cleanedText += c.text;
            }
          }
        } else if (parsed.type === "chunk" && parsed.delta) {
          const delta = parsed.delta;
          if (delta.type === "text" && delta.text) {
            cleanedText += delta.text;
          }
        }
      }
    } catch {
      // Not JSON — ignore (non-JSON lines can appear in error cases)
    }
  }

  // If JSON parsing produced nothing, fall back to raw text
  if (!cleanedText.trim()) {
    cleanedText = raw;
  }

  lines = cleanedText.split("\n").length;

  // Apply caps
  if (cleanedText.length > maxBytes) {
    cleanedText = cleanedText.slice(0, maxBytes) + "\n... (truncated by byte limit)";
    truncated = true;
  }

  const textLines = cleanedText.split("\n");
  if (textLines.length > maxLines) {
    cleanedText = textLines.slice(0, maxLines).join("\n") + "\n... (truncated by line limit)";
    truncated = true;
  }

  lines = cleanedText.split("\n").length;

  return { cleanedText, modelUsed, truncated, lines };
}

// ══════════════════════════════════════════════
// 10. OLD COMPAT WRAPPER: runSubagent
// ══════════════════════════════════════════════

/**
 * Legacy compatibility wrapper that maps old SubagentRunRequest to new runPhenixSubagent.
 *
 * NOTE: Unlike the old implementation, this does NOT call streaming APIs directly
 * direct model API. It spawns a real child pi process.
 */
export async function runSubagent(
  request: SubagentRunRequest,
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<SubagentRunResult> {
  const roleMap: Record<string, PhenixSubagentRole> = {
    scout: "scout",
    planner: "planner",
    architect: "architect",
    worker: "worker",
    verifier: "verifier",
    safety_reviewer: "reviewer",
  };

  const role = roleMap[request.role] ?? "worker";
  const modelStr = `${request.modelSet.provider}/${request.modelSet.model}`;

  // Build concise context for the child
  const contextLines: string[] = [];
  if (request.contextPack?.relevantFiles?.length > 0) {
    contextLines.push("## Relevant files");
    for (const f of request.contextPack.relevantFiles.slice(0, 10)) {
      contextLines.push(`- ${f.path}:${f.lines}`);
      if (f.content && f.content.length < 2000) {
        contextLines.push("```");
        contextLines.push(f.content.slice(0, 2000));
        contextLines.push("```");
      }
    }
  }
  if (request.contextPack?.projectStructure) {
    contextLines.push("## Project structure");
    contextLines.push("```");
    contextLines.push(request.contextPack.projectStructure.slice(0, 1000));
    contextLines.push("```");
  }

  const taskWithContext = [
    request.taskBrief,
    contextLines.join("\n"),
    "",
    `## Output schema`,
    request.outputSchema === "EvidencePacket"
      ? 'Return JSON: { "summary": "...", "relevantFiles": [...], "symbols": [...], "likelyEditPoints": [...], "risks": [...], "confidence": "low|medium|high" }'
      : request.outputSchema,
  ].join("\n\n");

  const result = await runPhenixSubagent(
    {
      role,
      task: taskWithContext,
      cwd: ctx.cwd,
      model: modelStr,
      tools: request.toolPolicy?.allowedTools ?? ROLE_TOOL_DEFAULTS[role],
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
      timeoutMs: 120000,
    },
    ctx,
  );

  const taskId = request.taskId;
  let status: SubagentStatus = result.status === "done" ? "done" : "failed";

  // Try to extract evidence packet from text
  let parsedBody: Record<string, unknown> = { raw: result.text.slice(0, 5000) };
  try {
    const jsonMatch = result.text.match(/```(?:json)?\s*\n?({[\s\S]*?})\n?\s*```/);
    if (jsonMatch) {
      parsedBody = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
    } else {
      const objMatch = result.text.match(/\{[\s\S]*"summary"[\s\S]*\}/);
      if (objMatch) {
        parsedBody = JSON.parse(objMatch[0]) as Record<string, unknown>;
      }
    }
  } catch {
    // Keep raw
  }

  const reportType: SubagentReport["type"] =
    request.role === "scout" && result.status === "done" ? "discovery"
    : request.role === "verifier" ? "verification"
    : "done";

  return {
    taskId,
    status,
    report: {
      type: reportType,
      summary: result.summary,
      body: parsedBody,
      evidenceRefs: [],
    },
    publicCard: {
      taskId,
      status: status === "done" ? "done" : "failed",
      summary: `Subagent ${request.role} completed (real subprocess pi)`,
      currentFocus: null,
      latestReportRef: null,
    },
    artifactRefs: [],
    toolPolicyEnforced: "prompt_only",
    turnsUsed: 1,
    modelUsed: result.modelUsed ?? modelStr,
  };
}

// ══════════════════════════════════════════════
// 11. CONTEXT PACK HELPER
// ══════════════════════════════════════════════

export async function buildScoutContextPack(
  cwd: string,
  pi: ExtensionAPI,
  prompt: string,
): Promise<ContextPack> {
  const pack: ContextPack = {
    relevantFiles: [],
    relevantSymbols: [],
    userPrompt: prompt,
    taskBrief: "Locate and summarize the repository context relevant to the user's request.",
    inheritedDecisions: [],
  };

  try {
    const { stdout: topLevel } = await pi.exec("ls", ["-1", cwd]);
    pack.projectStructure = `Top-level:\n${topLevel || "(empty)"}`;

    for (const dir of ["src", "lib", "config", "packages", "modules", "pi", "docs"]) {
      const dirPath = `${cwd}/${dir}`;
      try {
        const { stdout: listing } = await pi.exec("ls", ["-1", dirPath]);
        if (listing) pack.projectStructure += `\n${dir}/:\n${listing}`;
      } catch {
        // dir doesn't exist
      }
    }

    const keywords = prompt
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3 && !["the", "this", "that", "with", "from", "have", "been", "what", "when", "where", "which", "their", "there"].includes(w))
      .slice(0, 5);

    for (const keyword of keywords) {
      try {
        const { stdout } = await pi.exec("bash", ["-c", `find ${cwd} -type f -iname "*${keyword}*" 2>/dev/null | head -10`]);
        if (stdout) {
          for (const filePath of stdout.trim().split("\n").slice(0, 5)) {
            const relativePath = filePath.replace(cwd, "").replace(/^\//, "");
            try {
              const { stdout: content } = await pi.exec("head", ["-n", "200", filePath]);
              const lineCount = content.split("\n").length;
              pack.relevantFiles.push({
                path: relativePath,
                lines: `1-${lineCount}`,
                content,
              });
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }

    for (const configFile of ["package.json", "flake.nix", ".tend.json", "routing-config.yaml"]) {
      const configPath = `${cwd}/${configFile}`;
      try {
        const { stdout: content } = await pi.exec("head", ["-n", "100", configPath]);
        pack.relevantFiles.push({
          path: configFile,
          lines: "1-100",
          content,
        });
      } catch { /* skip */ }
    }
  } catch {
    // Best effort
  }

  return pack;
}

// ══════════════════════════════════════════════
// 12. HELPERS
// ══════════════════════════════════════════════

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

function findAgentFile(role: PhenixSubagentRole, cwd: string): string | null {
  const configDir = process.env.PI_CODING_AGENT_DIR;
  const agentFileName = `${role}.md`;
  const underscoresName = role.replace(/_/g, "_") + ".md";
  const name = /^[a-z]+$/.test(role) ? `${role}.md` : agentFileName;

  const candidates: string[] = [];
  // Check Phenix config agents directory first
  if (configDir) {
    candidates.push(path.join(configDir, "agents", name));
  }
  // Also check project .pi/agents
  candidates.push(path.join(cwd, ".pi", "agents", name));
  // Check Pi home dir
  const home = os.homedir();
  candidates.push(path.join(home, ".pi", "agent", "agents", name));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not found */ }
  }
  return null;
}

// ══════════════════════════════════════════════
// 13. SUBAGENT COMM CHANNEL
// ══════════════════════════════════════════════

/**
 * SubagentCommChannel — structured inter-subagent communication via shared JSON files.
 *
 * Parallel subagents exchange results by writing/reading well-known files in a
 * shared temporary directory. This is a simple, reliable, file-based IPC mechanism
 * that works without any external message broker or Pi RPC infrastructure.
 *
 * Each subagent run receives the comm directory path via COMM_CHANNEL_DIR env var.
 * Subagents write structured results as JSON files that other subagents can read.
 */

export interface CommMessage {
  /** Unique message ID (e.g. "scout-result-1712345678") */
  id: string;
  /** Source role */
  source: PhenixSubagentRole | "orchestrator";
  /** Target role (or "all" for broadcast) */
  target: PhenixSubagentRole | "all";
  /** Message type */
  type: "evidence" | "plan" | "patch" | "verification" | "status" | "error" | "signal";
  /** ISO timestamp */
  timestamp: string;
  /** Structured payload */
  payload: Record<string, unknown>;
  /** Optional TTL in ms — messages older than TTL are cleaned up */
  ttlMs?: number;
}

export interface CommChannelOptions {
  /** Shared temp directory — auto-created if not specified */
  dir?: string;
  /** Auto-cleanup on process exit */
  autoCleanup?: boolean;
}

const COMM_CHANNEL_DIR_ENV = "PI_SUBAGENT_COMM_DIR";

/**
 * Ensure the comm channel directory exists. Returns the absolute path.
 */
export function ensureCommChannelDir(
  cwd: string,
  options?: CommChannelOptions,
): string {
  const dir = options?.dir ?? path.join(cwd, COMM_CHANNEL_DEFAULTS.dirName, `comm-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Already exists or can't create — fall back to os.tmpdir
    const fallback = path.join(os.tmpdir(), COMM_CHANNEL_DEFAULTS.dirName, `comm-${Date.now()}`);
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
  return dir;
}

/**
 * Write a result/message to the comm channel.
 */
export function writeCommMessage(
  dir: string,
  message: CommMessage,
): string {
  const filePath = path.join(
    dir,
    `${COMM_CHANNEL_DEFAULTS.filePrefix}${message.id}.json`,
  );
  fs.writeFileSync(filePath, JSON.stringify(message, null, 2), "utf-8");
  return filePath;
}

/**
 * Read a single comm message by ID.
 */
export function readCommMessage(
  dir: string,
  id: string,
): CommMessage | null {
  const filePath = path.join(dir, `${COMM_CHANNEL_DEFAULTS.filePrefix}${id}.json`);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as CommMessage;
  } catch {
    return null;
  }
}

/**
 * List all comm messages, optionally filtered by type, source, or target.
 */
export function listCommMessages(
  dir: string,
  options?: {
    type?: CommMessage["type"];
    source?: CommMessage["source"];
    target?: CommMessage["target"];
    maxAgeMs?: number;
  },
): CommMessage[] {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(COMM_CHANNEL_DEFAULTS.filePrefix) && f.endsWith(".json"));

    const results: CommMessage[] = [];
    const now = Date.now();
    const maxAge = options?.maxAgeMs ?? COMM_CHANNEL_DEFAULTS.maxAgeMs;

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf-8");
        const msg = JSON.parse(raw) as CommMessage;
        const msgAge = now - new Date(msg.timestamp).getTime();

        // Skip expired messages
        if (msg.ttlMs && msgAge > msg.ttlMs) continue;
        if (msgAge > maxAge) continue;

        // Apply filters
        if (options?.type && msg.type !== options.type) continue;
        if (options?.source && msg.source !== options.source) continue;
        if (options?.target && msg.target !== options.target) continue;

        results.push(msg);
      } catch {
        // Skip unparseable files
      }
    }

    return results.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  } catch {
    return [];
  }
}

/**
 * Wait for a message matching the given predicate. Polls the directory.
 * Returns null if timeout is reached before a matching message appears.
 */
export async function waitForCommMessage(
  dir: string,
  predicate: (msg: CommMessage) => boolean,
  timeoutMs: number = PARALLEL_DEFAULTS.commTimeoutMs,
): Promise<CommMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = listCommMessages(dir);
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/**
 * Write a structured result file that a subagent produces, making it
 * available for other parallel subagents or the orchestrator.
 */
export function writeSubagentResult(
  dir: string,
  runId: string,
  role: PhenixSubagentRole,
  result: RunPhenixSubagentResult,
): string {
  const filePath = path.join(
    dir,
    `${COMM_CHANNEL_DEFAULTS.resultFilePrefix}${runId}-${role}.json`,
  );
  fs.writeFileSync(
    filePath,
    JSON.stringify({ id: runId, role, timestamp: result.endedAt, result }, null, 2),
    "utf-8",
  );
  return filePath;
}

/**
 * Read a subagent result file by run ID and role.
 */
export function readSubagentResult(
  dir: string,
  runId: string,
  role: PhenixSubagentRole,
): { result: RunPhenixSubagentResult } | null {
  const filePath = path.join(
    dir,
    `${COMM_CHANNEL_DEFAULTS.resultFilePrefix}${runId}-${role}.json`,
  );
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as { result: RunPhenixSubagentResult };
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════
// 14. PARALLEL SUBAGENT EXECUTION
// ══════════════════════════════════════════════

export interface ParallelSubagentInput {
  /** Unique ID for this subagent within the parallel batch */
  id: string;
  /** Input to pass to runPhenixSubagent */
  input: RunPhenixSubagentInput;
}

export interface ParallelSubagentOutput {
  id: string;
  result: RunPhenixSubagentResult;
}

export interface RunParallelSubagentsOptions {
  /** Maximum number of subagents to run concurrently (default: 4) */
  maxConcurrency?: number;
  /** Comm channel directory — if set, results are written to comm channel */
  commDir?: string;
  /** Optional caller override for comm messages */
  commSource?: PhenixSubagentRole | "orchestrator";
}

/**
 * Run multiple subagents in parallel with configurable concurrency.
 *
 * Subagents are spawned as independent child pi processes and run concurrently.
 * Results are returned as an array, preserving input order.
 *
 * If a commDir is provided, each subagent's result is written to the comm channel
 * as it completes, making it available to other concurrently running subagents.
 *
 * Concurrency is controlled via PARALLEL_DEFAULTS.maxConcurrency.
 * Total subagents across all parallel batches is bounded by RECURSION_DEFAULTS.maxTotalSubagents
 * and PARALLEL_DEFAULTS.maxTotalSubagents (whichever is lower).
 */
export async function runPhenixSubagentsParallel(
  subagents: ParallelSubagentInput[],
  ctx: ExtensionContext,
  options?: RunParallelSubagentsOptions,
): Promise<ParallelSubagentOutput[]> {
  const maxConcurrency = Math.min(
    options?.maxConcurrency ?? PARALLEL_DEFAULTS.maxConcurrency,
    subagents.length,
  );
  const maxTotal = Math.min(
    RECURSION_DEFAULTS.maxTotalSubagents,
    PARALLEL_DEFAULTS.maxTotalSubagents,
  );

  // Guard: don't exceed total subagent limit
  if (subagents.length > maxTotal) {
    const exceeded = subagents.slice(maxTotal);
    const within = subagents.slice(0, maxTotal);
    for (const item of exceeded) {
      ctx.ui?.notify?.(
        `⚠️ Parallel subagent limit reached (${maxTotal}). Skipping: ${item.id} (${item.input.role})`,
        "warning",
      );
    }
    subagents = within;
  }

  const results: ParallelSubagentOutput[] = [];
  const running: Promise<void>[] = [];
  const queue = [...subagents];

  // Process queue with bounded concurrency
  async function processNext(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const result = await runPhenixSubagent(item.input, ctx);

        // Write to comm channel if provided
        if (options?.commDir) {
          writeSubagentResult(options.commDir, item.id, item.input.role, result);
          writeCommMessage(options.commDir, {
            id: `${item.input.role}-complete-${Date.now()}`,
            source: options.commSource ?? item.input.role,
            target: "all",
            type: result.status === "done" ? "status" : "error",
            timestamp: result.endedAt,
            payload: {
              subagentId: item.id,
              role: item.input.role,
              status: result.status,
              summary: result.summary,
              truncated: result.truncated,
            },
          });
        }

        results.push({ id: item.id, result });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errorResult: RunPhenixSubagentResult = {
          status: "failed",
          role: item.input.role,
          modelUsed: item.input.model ?? null,
          cwd: item.input.cwd,
          summary: `Parallel subagent error: ${errMsg}`,
          text: "",
          bytes: 0,
          lines: 0,
          truncated: false,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          exitCode: null,
          error: errMsg,
        };
        results.push({ id: item.id, result: errorResult });
      }
    }
  }

  // Start maxConcurrency workers
  const workers = Array.from({ length: maxConcurrency }, () => processNext());
  await Promise.all(workers);

  // Sort results to match input order
  const orderedMap = new Map(results.map((r) => [r.id, r]));
  return subagents.map((s) => orderedMap.get(s.id) ?? {
    id: s.id,
    result: {
      status: "failed" as const,
      role: s.input.role,
      modelUsed: null,
      cwd: s.input.cwd,
      summary: "Subagent not started (parallel limit or error)",
      text: "",
      bytes: 0,
      lines: 0,
      truncated: false,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: null,
      error: "not_started",
    },
  });
}

// ══════════════════════════════════════════════
// Standalone extension entry point (no-op)
// ══════════════════════════════════════════════

export default function phenixSubagentExecutor(_pi: ExtensionAPI): void {
  // This module is a library consumed via imports.
  // No commands, tools, or event handlers are registered here.
}
