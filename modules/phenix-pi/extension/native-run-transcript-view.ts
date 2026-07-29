import { Container, Text } from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { LoadedWorkspaceTranscript } from "../ports/workspace-effects.ts";
import type { NativeRunTranscript } from "./native-run-transcript.ts";
import { transcriptAvailabilityMessage } from "./transcript-availability.ts";

export function renderNativeRunTranscriptResult(
  loaded: LoadedWorkspaceTranscript<NativeRunTranscript>,
  node: RunTreeNode,
): NativeRunTranscript {
  if (loaded.kind === "ready") return loaded.value;
  const component = new Container();
  component.addChild(
    new Text(transcriptAvailabilityMessage(loaded) ?? "Transcript data is unavailable.", 0, 0),
  );
  return {
    component,
    sessionId: node.run.pi?.sessionId ?? String(node.run.id),
    ...(node.run.pi?.sessionFile ? { sessionFile: node.run.pi.sessionFile } : {}),
  };
}
