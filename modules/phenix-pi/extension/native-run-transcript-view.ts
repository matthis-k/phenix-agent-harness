import type { RunTreeNode } from "../application/interfaces.ts";
import type { LoadedWorkspaceTranscript } from "../ports/workspace-effects.ts";
import type { NativeRunTranscript } from "./native-run-transcript.ts";
import { documentComponent } from "./presentation-component.ts";
import { transcriptAvailabilityMessage } from "./transcript-availability.ts";

export function renderNativeRunTranscriptResult(
  loaded: LoadedWorkspaceTranscript<NativeRunTranscript>,
  node: RunTreeNode,
): NativeRunTranscript {
  if (loaded.kind === "ready") return loaded.value;
  return {
    component: documentComponent([
      transcriptAvailabilityMessage(loaded) ?? "Transcript data is unavailable.",
    ]),
    sessionId: node.run.pi?.sessionId ?? String(node.run.id),
    ...(node.run.pi?.sessionFile ? { sessionFile: node.run.pi.sessionFile } : {}),
  };
}
