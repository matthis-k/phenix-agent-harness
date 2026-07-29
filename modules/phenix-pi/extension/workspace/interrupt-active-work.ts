import type { PhenixRuntime } from "../../composition/create-phenix-runtime.ts";
import type { RunId } from "../../domain/shared.ts";

export const USER_INTERRUPT_REASON = "Interrupted by user";

type InterruptRuntime = Pick<PhenixRuntime, "execution">;

export async function interruptActiveRootWork(
  runtime: InterruptRuntime,
  rootRunId: RunId,
  reason = USER_INTERRUPT_REASON,
): Promise<readonly RunId[]> {
  const root = await runtime.execution.inspect(rootRunId);
  const targets = [...root.activeChildren];
  await Promise.all(targets.map((runId) => runtime.execution.cancel(runId, reason)));
  return targets;
}
