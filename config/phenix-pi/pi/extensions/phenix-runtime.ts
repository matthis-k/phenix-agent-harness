/**
 * phenix-runtime.ts — Recursive Multi-Agent Workflow Runtime
 *
 * Data models, prompt assembly, output schemas, and coordination logic
 * for the Phenix recursive agent workflow.
 *
 * This module is a TYPE LAYER + PROMPT ASSEMBLY layer. It does NOT register
 * commands or Pi event handlers directly. Those live in phenix-flow.ts
 * (orchestrator) and phenix-router.ts (model routing).
 *
 * To use: import { ... } from "./phenix-runtime" from event handlers.
 * The models here are plain TypeScript types and pure functions.
 */

// ══════════════════════════════════════════════
// 1. ROLE POLICIES
// ══════════════════════════════════════════════

export type RolePolicy =
  | "router"
  | "architect"
  | "supervisor_worker"
  | "worker"
  | "scout"
  | "verifier"
  | "integrator"
  | "safety_reviewer";

export const ROLE_AUTHORITY: Record<RolePolicy, string> = {
  router: "Route prompts to appropriate workflow mode and planner interaction mode.",
  architect: "Define global scope, decomposition, contracts, invariants, and verification strategy. Ask the user targeted clarification questions if planner interaction mode allows. Do not perform implementation edits. Produce a PlanContract and task briefs suitable for workers.",
  supervisor_worker: "Own this task subtree. Implement directly when delegation is not worthwhile. Delegate only coherent non-trivial subtasks with clear scope, low context overlap, and verifiable success criteria. Integrate child reports before reporting upward. Resolve child blockers when inside your authority. Escalate scope-changing ambiguity to parent/planner.",
  worker: "Implement the assigned scoped task. Respect allowed paths and contracts. Do not delegate. Do not ask the user. If scope is insufficient, publish a scope_issue or scope_expansion_request. Report changed files, checks, issues, and artifact refs.",
  scout: "Gather evidence only. Do not edit files. Do not decide architecture. Do not delegate. Stop when enough evidence exists to answer the brief.",
  verifier: "Validate patch, tests, diagnostics, and scope compliance. Be skeptical and concrete. Do not redesign the solution. Report pass/fail with evidence and required fixes.",
  integrator: "Merge child outputs. Resolve interface conflicts. Ensure naming, contracts, and behavior are consistent. Report unresolved issues upward.",
  safety_reviewer: "Review changes for execution, auth, file IO, path traversal, secrets, permissions, and MCP risks. Do not edit. Report concrete risks and required mitigations.",
};

// ══════════════════════════════════════════════
// 2. EXECUTION PROFILES
// ══════════════════════════════════════════════

export interface ExecutionProfile {
  role: RolePolicy;
  tools: string[];
  outputSchema: string;
  permissions: Permissions;
}

export const PROFILES: Record<string, ExecutionProfile> = {
  repo_scout: {
    role: "scout",
    tools: ["find", "search", "read_range", "ast_grep", "lsp_symbols"],
    outputSchema: "EvidencePacket",
    permissions: { read: true, edit: false, shell: "read_only", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
  },
  implementation: {
    role: "worker",
    tools: ["read_range", "search", "edit", "test"],
    outputSchema: "PatchReport",
    permissions: { read: true, edit: true, shell: "safe", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
  },
  refactor: {
    role: "worker",
    tools: ["search", "ast_grep", "ast_edit", "lsp_rename", "test"],
    outputSchema: "RefactorReport",
    permissions: { read: true, edit: true, shell: "safe", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
  },
  test_author: {
    role: "worker",
    tools: ["read_range", "search", "edit", "test"],
    outputSchema: "TestReport",
    permissions: { read: true, edit: true, shell: "safe", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
  },
  verifier_patch: {
    role: "verifier",
    tools: ["read_range", "diff", "test", "diagnostics"],
    outputSchema: "VerificationReport",
    permissions: { read: true, edit: false, shell: "safe", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
  },
  safety_io: {
    role: "safety_reviewer",
    tools: ["read_range", "search", "diff"],
    outputSchema: "RiskReport",
    permissions: { read: true, edit: false, shell: "read_only", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
  },
};

// ══════════════════════════════════════════════
// 3. PERMISSIONS
// ══════════════════════════════════════════════

export interface Permissions {
  read: boolean;
  edit: boolean;
  shell: "none" | "read_only" | "safe" | "unrestricted";
  network: boolean;
  canDelegate: boolean | "initial_only" | "limited";
  canAskUser: boolean;
  canUpdatePlan: boolean;
  canPublishContracts: boolean;
  canReservePaths: boolean;
}

export const DEFAULT_PERMISSIONS: Record<RolePolicy, Permissions> = {
  router: { read: true, edit: false, shell: "none", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
  architect: { read: true, edit: false, shell: "read_only", network: false, canDelegate: "initial_only", canAskUser: true, canUpdatePlan: true, canPublishContracts: true, canReservePaths: false },
  supervisor_worker: { read: true, edit: true, shell: "safe", network: false, canDelegate: true, canAskUser: false, canUpdatePlan: false, canPublishContracts: true, canReservePaths: true },
  worker: { read: true, edit: true, shell: "safe", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
  scout: { read: true, edit: false, shell: "read_only", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
  verifier: { read: true, edit: false, shell: "safe", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
  integrator: { read: true, edit: true, shell: "safe", network: false, canDelegate: "limited", canAskUser: false, canUpdatePlan: false, canPublishContracts: true, canReservePaths: true },
  safety_reviewer: { read: true, edit: false, shell: "read_only", network: false, canDelegate: false, canAskUser: false, canUpdatePlan: false, canPublishContracts: false, canReservePaths: false },
};

// ══════════════════════════════════════════════
// 4. SCOPE
// ══════════════════════════════════════════════

export interface Scope {
  allowedPaths: string[];
  forbiddenPaths: string[];
  ownedContracts: string[];
  consumedContracts: string[];
  allowedSymbols: string[];
  forbiddenSymbols: string[];
}

export function scopeContainsPath(scope: Scope, path: string): boolean {
  if (scope.forbiddenPaths.some((p) => path.startsWith(p) || p === path)) return false;
  if (scope.allowedPaths.some((p) => path.startsWith(p) || p === path)) return true;
  // Default: if nothing is explicitly allowed and nothing is forbidden, allow
  if (scope.allowedPaths.length === 0) return true;
  return false;
}

// ══════════════════════════════════════════════
// 5. PLAN CONTRACT
// ══════════════════════════════════════════════

export type PlanContractStatus = "draft" | "awaiting_user" | "frozen" | "amended";

export interface PlanTask {
  id: string;
  title: string;
  role: RolePolicy;
  profile: string;
  objective: string;
  scope: Scope;
  successCriteria: string[];
  dependencies: string[];
}

export interface PlanContract {
  id: string;
  status: PlanContractStatus;
  userConfirmed: boolean;
  goal: string;
  decisions: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  invariants: string[];
  escalationPolicy: {
    workersMayAskUser: boolean;
    supervisorsMayAskUser: boolean;
    plannerMayAskUser: boolean;
    askUserWhen: string[];
    plannerMayDecideWhen: string[];
  };
  implementationTasks: PlanTask[];
  sharedContracts: string[];
}

export interface PlanAmendment {
  id: string;
  planContractId: string;
  sourceReportId: string;
  status: "proposed" | "accepted" | "rejected" | "awaiting_user";
  reason: string;
  decision: string | null;
  affectedTasks: string[];
  userVisible: boolean;
}

export type PlannerInteractionMode = "auto" | "ask_if_unclear" | "require_plan_approval" | "collaborative";

// ══════════════════════════════════════════════
// 6. TASK NODE
// ══════════════════════════════════════════════

export type TaskStatus =
  | "proposed"
  | "scoped"
  | "active"
  | "blocked"
  | "needs_fix"
  | "review"
  | "done"
  | "integrated"
  | "cancelled";

export interface TaskNode {
  id: string;
  sessionId: string;
  parentId: string | null;
  children: string[];
  role: RolePolicy;
  profile: string;
  status: TaskStatus;
  objective: string;
  successCriteria: string[];
  nonGoals: string[];
  scope: Scope;
  permissions: Permissions;
  budgets: Record<string, number>;
  contextPackRef: string | null;
  planContractRef: string | null;
  publicCard: PublicCard;
  reports: string[];
  artifacts: string[];
  dependencies: Dependency[];
  createdAt: number;
  updatedAt: number;
}

// ══════════════════════════════════════════════
// 7. PUBLIC CARD
// ══════════════════════════════════════════════

export interface PublicCard {
  taskId: string;
  status: TaskStatus;
  summary: string;
  currentFocus: string | null;
  changedFiles: string[];
  interfaceExports: string[];
  blockers: Blocker[];
  openQuestions: string[];
  latestReportRef: string | null;
  updatedAt: number;
}

export interface Blocker {
  description: string;
  blockedByTaskId: string | null;
  dependencyKind: string | null;
}

// ══════════════════════════════════════════════
// 8. REPORTS
// ══════════════════════════════════════════════

export type ReportType =
  | "discovery"
  | "done"
  | "blocker"
  | "scope_issue"
  | "scope_expansion_request"
  | "interface_request"
  | "interface_change"
  | "verification"
  | "safety_risk"
  | "ambiguity_report"
  | "planner_decision"
  | "handoff";

export type ReportAudience = "parent" | "siblings" | "subtree" | "session";

export interface Report {
  id: string;
  taskId: string;
  type: ReportType;
  audience: ReportAudience;
  summary: string;
  body: Record<string, unknown>;
  evidenceRefs: string[];
  createdAt: number;
}

// ══════════════════════════════════════════════
// 9. ARTIFACT REF
// ══════════════════════════════════════════════

export type ArtifactKind =
  | "patch"
  | "log"
  | "file_range"
  | "scout_report"
  | "diagnostic"
  | "contract"
  | "test_result"
  | "plan_contract"
  | "context_pack";

export type ArtifactVisibility = "private" | "parent" | "siblings" | "subtree" | "session";

export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  uri: string;
  visibility: ArtifactVisibility;
  summary: string;
}

// ══════════════════════════════════════════════
// 10. CONTRACT REGISTRY
// ══════════════════════════════════════════════

export type ContractStatus = "draft" | "active" | "deprecated";

export interface Contract {
  name: string;
  version: number;
  ownerTaskId: string | null;
  status: ContractStatus;
  fields: Record<string, unknown>;
  consumers: string[];
  createdAt: number;
  updatedAt: number;
}

// ══════════════════════════════════════════════
// 11. DEPENDENCIES & BLOCKERS
// ══════════════════════════════════════════════

export type DependencyKind =
  | "waits_for_contract"
  | "waits_for_patch"
  | "waits_for_review"
  | "blocked_by_issue";

export interface Dependency {
  fromTask: string;
  toTask: string;
  kind: DependencyKind;
  reason: string;
  status: "open" | "resolved";
}

// ══════════════════════════════════════════════
// 12. PATH LOCKS
// ══════════════════════════════════════════════

export type LockMode = "read" | "write";

export interface PathLock {
  path: string;
  ownerTaskId: string;
  mode: LockMode;
  reason: string;
  createdAt: number;
}

// ══════════════════════════════════════════════
// 13. CONTEXT PACK
// ══════════════════════════════════════════════

export interface ContextPack {
  id: string;
  taskId: string;
  planContractRef: string | null;
  objective: string;
  successCriteria: string[];
  nonGoals: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  inheritedDecisions: string[];
  inheritedContracts: string[];
  evidenceRefs: string[];
  parentPublicCardRef: string | null;
  relevantPeerCards: string[];
  outputSchema: string;
}

// ══════════════════════════════════════════════
// 14. OUTPUT SCHEMAS
// ══════════════════════════════════════════════

export interface EvidencePacket {
  summary: string;
  relevantFiles: Array<{ path: string; lines: string; reason: string }>;
  symbols: Array<{ name: string; location: string; reason: string }>;
  currentBehavior: string | null;
  likelyEditPoints: Array<{ path: string; reason: string }>;
  risks: string[];
  confidence: "low" | "medium" | "high";
}

export interface PatchReport {
  summary: string;
  filesChanged: Array<{ path: string; reason: string }>;
  interfaceChanges: string[];
  checksRun: Array<{ command: string; result: "pass" | "fail" | "not_run" }>;
  unresolvedIssues: string[];
  artifactRefs: string[];
}

export interface VerificationReport {
  status: "pass" | "fail";
  failures: Array<{ issue: string; evidence: string; ownerHint: string | null; requiredFix: string }>;
  checks: Array<{ command: string; result: "pass" | "fail" | "not_run" }>;
  scopeViolations: string[];
}

export interface RiskReport {
  status: "pass" | "fail";
  risks: Array<{ severity: "low" | "medium" | "high"; issue: string; evidence: string; requiredFix: string }>;
}

// ══════════════════════════════════════════════
// 15. PROMPT ASSEMBLY
// ══════════════════════════════════════════════

export const BASE_RUNTIME_CONTRACT = `You are an agent inside the pi/Phenix recursive team runtime.

Follow your assigned authority, scope, tools, and output schema exactly.
Do not expand scope unless explicitly allowed.
Do not include raw logs, full files, or long transcripts in your response.
Use artifact refs, file refs, log refs, and compact evidence instead.
If blocked, report the smallest sufficient blocker to your parent.
Your private work is not automatically visible to other agents. Publish only compact public state and reports.`;

export function assembleSystemPrompt(opts: {
  role: RolePolicy;
  profile?: ExecutionProfile;
  taskBrief?: string;
  contextPack?: ContextPack;
  outputSchema?: string;
  communicationRules?: string[];
  stopConditions?: string[];
}): string {
  const parts: string[] = [BASE_RUNTIME_CONTRACT];

  // Role authority fragment
  parts.push(`\n## Role: ${opts.role}\n${ROLE_AUTHORITY[opts.role]}`);

  // Permissions fragment
  const perms = opts.profile?.permissions ?? DEFAULT_PERMISSIONS[opts.role];
  parts.push(`\n## Permissions\n${formatPermissions(perms)}`);

  // Profile tools fragment
  if (opts.profile) {
    parts.push(`\n## Available Tools\n${opts.profile.tools.map((t) => `- ${t}`).join("\n")}`);
  }

  // Task brief
  if (opts.taskBrief) {
    parts.push(`\n## Task Brief\n${opts.taskBrief}`);
  }

  // Context pack
  if (opts.contextPack) {
    parts.push(`\n## Context\n${formatContextPack(opts.contextPack)}`);
  }

  // Output schema
  if (opts.outputSchema) {
    parts.push(`\n## Output Schema\nProduce output conforming to: ${opts.outputSchema}`);
  }

  // Stop conditions
  if (opts.stopConditions && opts.stopConditions.length > 0) {
    parts.push(`\n## Stop Conditions\n${opts.stopConditions.map((c) => `- ${c}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

function formatPermissions(p: Permissions): string {
  const lines: string[] = [];
  lines.push(`- Read files: ${p.read ? "yes" : "no"}`);
  lines.push(`- Edit files: ${p.edit ? "yes" : "no"}`);
  lines.push(`- Shell: ${p.shell}`);
  lines.push(`- Network: ${p.network ? "yes" : "no"}`);
  lines.push(`- Delegate: ${p.canDelegate}`);
  lines.push(`- Ask user: ${p.canAskUser ? "yes" : "no"}`);
  lines.push(`- Update plan: ${Boolean(p.canUpdatePlan) ? "yes" : "no"}`);
  lines.push(`- Publish contracts: ${Boolean(p.canPublishContracts) ? "yes" : "no"}`);
  lines.push(`- Reserve paths: ${p.canReservePaths ? "yes" : "no"}`);
  return lines.join("\n");
}

function formatContextPack(cp: ContextPack): string {
  const lines: string[] = [`Objective: ${cp.objective}`];
  if (cp.allowedPaths.length > 0) lines.push(`Allowed paths: ${cp.allowedPaths.join(", ")}`);
  if (cp.forbiddenPaths.length > 0) lines.push(`Forbidden paths: ${cp.forbiddenPaths.join(", ")}`);
  if (cp.successCriteria.length > 0) lines.push(`Success criteria:\n${cp.successCriteria.map((s) => `  - ${s}`).join("\n")}`);
  if (cp.nonGoals.length > 0) lines.push(`Non-goals:\n${cp.nonGoals.map((n) => `  - ${n}`).join("\n")}`);
  if (cp.inheritedContracts.length > 0) lines.push(`Contracts: ${cp.inheritedContracts.join(", ")}`);
  return lines.join("\n");
}

// ══════════════════════════════════════════════
// 16. SCOPE ESCALATION RESOLVER
// ══════════════════════════════════════════════

export interface ScopeIssue {
  type: "scope_issue" | "scope_expansion_request" | "interface_request";
  fromTaskId: string;
  affectedPaths: string[];
  affectedContracts: string[];
  reason: string;
  evidenceRefs: string[];
  proposedRouting: string[];
}

export interface ScopeResolution {
  action: "reject" | "expand_child_scope" | "create_child_task" | "forward_to_child" | "escalate" | "ask_user";
  targetTaskId?: string;
  reason: string;
  planAmendment?: PlanAmendment;
}

/**
 * Resolve a scope issue by walking up the task tree to find
 * the nearest supervisor with authority over the affected paths.
 */
export function resolveScopeIssue(
  issue: ScopeIssue,
  taskTree: Map<string, TaskNode>,
  planContract: PlanContract,
): ScopeResolution {
  const fromTask = taskTree.get(issue.fromTaskId);
  if (!fromTask) {
    return { action: "reject", reason: "Unknown task" };
  }

  // Walk up the parent chain
  let currentId: string | null = fromTask.parentId;
  while (currentId) {
    const current = taskTree.get(currentId);
    if (!current) break;

    // Does this supervisor own the affected paths?
    const ownsAffected = issue.affectedPaths.every((p) => scopeContainsPath(current.scope, p));
    if (ownsAffected) {
      // Check if an existing child already owns the affected area
      for (const childId of current.children) {
        const child = taskTree.get(childId);
        if (child && issue.affectedPaths.every((p) => scopeContainsPath(child.scope, p))) {
          return {
            action: "forward_to_child",
            targetTaskId: childId,
            reason: `Issue affects paths owned by child task ${childId}`,
          };
        }
      }

      // Check if this is a non-goal under the PlanContract
      for (const p of issue.affectedPaths) {
        for (const ng of planContract.nonGoals) {
          if (p.includes(ng) || ng.includes(p)) {
            return { action: "reject", reason: `Affected path "${p}" is a non-goal: ${ng}` };
          }
        }
      }

      // Expand scope or create child
      return {
        action: issue.type === "scope_expansion_request" ? "expand_child_scope" : "create_child_task",
        targetTaskId: currentId,
        reason: "Issue is within supervisor's authority",
      };
    }

    currentId = current.parentId;
  }

  // No supervisor found — escalate to root / ask user
  if (issue.type === "interface_request" || issue.affectedPaths.some((p) =>
    planContract.nonGoals.some((ng) => p.includes(ng)),
  )) {
    return {
      action: "ask_user",
      reason: `Scope issue "${issue.reason}" affects paths not covered by any existing scope or plan contract`,
    };
  }

  return { action: "reject", reason: "Scope issue cannot be resolved automatically" };
}

// ══════════════════════════════════════════════
// 17. DELEGATION GATE
// ══════════════════════════════════════════════

export interface DelegationDecision {
  shouldDelegate: boolean;
  reason: string;
}

export function shouldDelegate(task: {
  title: string;
  objective: string;
  successCriteria: string[];
  scope: Scope;
  estimatedComplexity: "trivial" | "bounded" | "complex";
}): DelegationDecision {
  // Do not delegate trivial work
  if (task.estimatedComplexity === "trivial") {
    return { shouldDelegate: false, reason: "Task is trivial — no delegation overhead warranted" };
  }

  // Do not delegate if success criteria are unclear
  if (task.successCriteria.length === 0) {
    return { shouldDelegate: false, reason: "Success criteria are unclear — cannot delegate safely" };
  }

  // Do not delegate if scope is unbounded
  if (task.scope.allowedPaths.length === 0) {
    return { shouldDelegate: false, reason: "Scope is unbounded — delegation risks scope creep" };
  }

  // Delegate bounded non-trivial work
  if (task.estimatedComplexity === "bounded" || task.estimatedComplexity === "complex") {
    return { shouldDelegate: true, reason: "Task is coherent, bounded, and verifiable" };
  }

  return { shouldDelegate: false, reason: "Default: do not delegate" };
}

export const RECURSIVE_DELEGATION_DEFAULTS = {
  enabled: false,
  maxDepth: 2,
};

// ══════════════════════════════════════════════
// 18. MCP COMMAND HELPERS
// ══════════════════════════════════════════════

/**
 * MCP tool name constants for the workflow operations.
 */
export const MCP_TOOLS = {
  // Sessions
  SESSION_INIT: "comm_session_init",
  SESSION_GET: "comm_session_get",
  SESSION_LIST: "comm_session_list",
  SESSION_CLOSE: "comm_session_close",

  // Agents
  AGENT_REGISTER: "comm_agent_register",
  AGENT_HEARTBEAT: "comm_agent_heartbeat",
  AGENT_UPDATE_STATUS: "comm_agent_update_status",
  AGENT_LIST: "comm_agent_list",

  // Messages
  MESSAGE_SEND: "comm_message_send",
  MESSAGE_LIST: "comm_message_list",
  MESSAGE_READ: "comm_message_read",
  MESSAGE_ACK: "comm_message_ack",
  MESSAGE_REPLY: "comm_message_reply",

  // Graphs / Task Trees
  GRAPH_CREATE: "comm_graph_create",
  GRAPH_GET: "comm_graph_get",
  GRAPH_SUMMARY: "comm_graph_summary",
  TASK_CREATE: "comm_task_create",
  TASK_UPDATE: "comm_task_update",
  TASK_ADD_DEPENDENCY: "comm_task_add_dependency",
  TASK_ADD_CHILD: "comm_task_add_child",
  TASK_CLAIM: "comm_task_claim",
  TASK_RELEASE: "comm_task_release",
  TASK_COMPLETE: "comm_task_complete",
  TASK_FAIL: "comm_task_fail",
  TASK_BLOCK: "comm_task_block",
  TASK_LIST_READY: "comm_task_list_ready",
  TASK_LIST_FOR_AGENT: "comm_task_list_for_agent",

  // Events
  EVENT_LIST: "comm_event_list",
  EVENT_RECENT: "comm_event_recent",

  // Artifacts
  ARTIFACT_RECORD: "comm_artifact_record",
  ARTIFACT_LIST: "comm_artifact_list",

  // Decisions
  DECISION_RECORD: "comm_decision_record",
  DECISION_LIST: "comm_decision_list",
};


// ══════════════════════════════════════════════
// Standalone extension entry point (no-op)
// phenix-runtime is a library module imported by
// phenix-flow.ts and other extensions. Pi scans
// all .ts files in the extensions directory, so
// we need a valid default export to avoid load errors.
// ══════════════════════════════════════════════

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function phenixRuntime(pi: ExtensionAPI): void {
  // phenix-runtime is a type/prompt-assembly library only.
  // No commands, tools, or event handlers are registered here.
  // All functionality is consumed via:
  //   import { ... } from "./phenix-runtime"
  void pi; // satisfy compiler — keep reference for API compatibility
}
