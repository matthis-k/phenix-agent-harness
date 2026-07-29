import type { TranscriptAvailability } from "../domain/workspace/state.ts";

export function transcriptAvailabilityMessage(
  availability: TranscriptAvailability,
): string | undefined {
  switch (availability.kind) {
    case "ready":
      return undefined;
    case "pending":
      return "Loading Pi transcript…";
    case "pending-persistence":
      return "Pi has allocated this transcript but has not persisted its first response yet.";
    case "not-applicable":
      return availability.reason === "workflow"
        ? "This workflow run does not own a Pi transcript."
        : "The root transcript is rendered from the active Pi session.";
    case "legacy":
      return "This agent run has no persisted Pi transcript reference.";
    case "invalid":
    case "invariant-violation":
      return availability.reason;
  }
}
