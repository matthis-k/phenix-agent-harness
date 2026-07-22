import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readWorkflowRecord } from "@matthis-k/phenix-flow/index.ts";
import { getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import { phenixRootModelScope } from "../composition/model-scope.ts";
import { assurancePolicyFor } from "./assurance.ts";
import type { ExecutionAuthority } from "./service.ts";

function isLifecycleControl(message: string): boolean {
  return /^(?:\/workflow\s+)?(?:resume|continue|keep\s+going|discard|stop|cancel)$/i.test(
    message.trim().replace(/[.!?]+$/u, ""),
  );
}

export function registerRootObjectiveIntegration(input: {
  readonly pi: ExtensionAPI;
  readonly authority: ExecutionAuthority;
}): void {
  input.pi.on("before_agent_start", async (event, ctx) => {
    if (!phenixRootModelScope.includes(ctx.model)) return;
    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    const runtime = getSessionRuntime(sessionId);
    const active = runtime.activeWorkflow;
    if (!active) return;
    const workflow = readWorkflowRecord(ctx.cwd, active.instanceId, active.actorId);
    if (!workflow) return;

    const existing = input.authority.activeObjectiveForSession(sessionId);
    if (!existing) {
      const policy = assurancePolicyFor({
        userTask: runtime.currentUserTask ?? event.prompt,
        difficulty: workflow.difficulty,
        mutation: workflow.definitionId.includes("implement") ? "local" : "none",
        userRequestedRigor: workflow.definitionId.includes("qa") ? "verified" : "normal",
        deterministicChecksAvailable: true,
      });
      input.authority.beginObjective(
        {
          id: workflow.instanceId,
          rootSessionId: sessionId,
          rootActorId: workflow.actorId,
          userTask: runtime.currentUserTask ?? event.prompt,
          workflowDefinitionId: workflow.definitionId,
          difficulty: workflow.difficulty,
          assurance: policy.level,
        },
        {
          idempotencyKey: `root-objective:${workflow.instanceId}`,
          actorId: workflow.actorId,
        },
      );
      return;
    }

    if (existing.id !== workflow.instanceId) {
      throw new Error(
        `Execution authority objective ${existing.id} conflicts with active workflow ${workflow.instanceId}.`,
      );
    }
    if (existing.state === "paused") {
      input.authority.resumeObjective(existing.id, {
        idempotencyKey: `root-resume:${workflow.instanceId}:${runtime.currentTurnId ?? "turn"}`,
        actorId: workflow.actorId,
        expectedRevision: existing.revision,
      });
      return;
    }

    const message = event.prompt.trim();
    if (
      message &&
      message !== existing.userTask &&
      message !== existing.latestAmendment &&
      !isLifecycleControl(message) &&
      !message.startsWith("Phenix background delegation ")
    ) {
      input.authority.amendObjective(existing.id, message, {
        idempotencyKey: `root-amend:${workflow.instanceId}:${runtime.currentTurnId ?? message}`,
        actorId: workflow.actorId,
        expectedRevision: existing.revision,
      });
    }
  });
}
