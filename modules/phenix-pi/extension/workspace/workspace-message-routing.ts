import type { PhenixRuntime } from "../../composition/create-phenix-runtime.ts";
import type { AttentionResult } from "../../domain/attention/model.ts";
import type { ProjectId, ProjectIntervention } from "../../domain/project/model.ts";
import type { RunId } from "../../domain/shared.ts";

export interface WorkspaceMessageRoute {
  readonly kind: "root" | "run" | "intervention";
  readonly targetRunId: RunId;
  readonly attention?: AttentionResult;
  readonly intervention?: ProjectIntervention;
}

export async function routeWorkspaceMessage(input: {
  readonly runtime: Pick<PhenixRuntime, "attention" | "projects">;
  readonly rootRunId: RunId;
  readonly targetRunId: RunId;
  readonly text: string;
  readonly sendRoot: (text: string) => void | Promise<void>;
}): Promise<WorkspaceMessageRoute> {
  if (input.targetRunId === input.rootRunId) {
    await input.sendRoot(input.text);
    return { kind: "root", targetRunId: input.rootRunId };
  }

  const pending = await newestPendingIntervention(input.runtime, input.targetRunId);
  if (pending) {
    const intervention = await input.runtime.projects.answerInput(
      pending.projectId,
      pending.intervention.id,
      input.text,
      { rootRunId: input.rootRunId, runId: input.rootRunId },
    );
    return {
      kind: "intervention",
      targetRunId: input.targetRunId,
      intervention,
    };
  }

  const attention = await input.runtime.attention.submit({
    rootRunId: input.rootRunId,
    message: input.text,
    source: { kind: "user" },
    targetRunIds: [input.targetRunId],
  });
  const delivery = attention.deliveries.find((candidate) => candidate.runId === input.targetRunId);
  if (!delivery || delivery.status === "failed") {
    throw new Error(delivery?.reason ?? `Run ${input.targetRunId} did not accept the message`);
  }
  return {
    kind: "run",
    targetRunId: input.targetRunId,
    attention,
  };
}

async function newestPendingIntervention(
  runtime: Pick<PhenixRuntime, "projects">,
  targetRunId: RunId,
): Promise<
  | {
      readonly projectId: ProjectId;
      readonly intervention: ProjectIntervention;
    }
  | undefined
> {
  const matches = (await runtime.projects.list()).flatMap((project) =>
    project.interventions
      .filter(
        (intervention) =>
          intervention.status === "pending" && intervention.requestedBy.runId === targetRunId,
      )
      .map((intervention) => ({ projectId: project.id, intervention })),
  );
  return matches.sort((left, right) => {
    const byTime = right.intervention.requestedAt.localeCompare(left.intervention.requestedAt);
    return byTime !== 0 ? byTime : right.intervention.id.localeCompare(left.intervention.id);
  })[0];
}
