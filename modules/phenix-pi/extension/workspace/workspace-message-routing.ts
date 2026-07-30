import type { AttentionResult } from "../../domain/attention/model.ts";
import type { RunId } from "../../domain/shared.ts";
import type { PhenixRuntime } from "../../composition/create-phenix-runtime.ts";

export interface WorkspaceMessageRoute {
  readonly kind: "root" | "run";
  readonly targetRunId: RunId;
  readonly attention?: AttentionResult;
}

export async function routeWorkspaceMessage(input: {
  readonly runtime: Pick<PhenixRuntime, "attention">;
  readonly rootRunId: RunId;
  readonly targetRunId: RunId;
  readonly text: string;
  readonly sendRoot: (text: string) => void | Promise<void>;
}): Promise<WorkspaceMessageRoute> {
  if (input.targetRunId === input.rootRunId) {
    await input.sendRoot(input.text);
    return { kind: "root", targetRunId: input.rootRunId };
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
