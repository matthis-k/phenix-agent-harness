import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createVisualizationArtifact,
  VISUALIZATION_EVENT,
} from "../../domain/presentation/visualization.ts";

const VISUAL_ACCEPTED = "Visual accepted.";

export function createVisualizationPublisherExtension(): ExtensionFactory {
  return (pi) => {
    let sourceSessionId = "unknown";
    const published = new Set<string>();

    pi.on("session_start", (_event, ctx) => {
      sourceSessionId = ctx.sessionManager.getSessionId();
      published.clear();
    });

    pi.registerTool({
      name: "phenix_visualize",
      label: "Render Mermaid",
      description:
        "Mark one section as a Mermaid diagram for UI-only Beautiful Mermaid rendering. Put the Mermaid source in this tool call instead of reproducing it in prose or the final report. The rendered diagram and its scrollable-view affordance are written directly to the user transcript; this tool returns only a minimal receipt so rendered output does not consume agent context.",
      promptSnippet:
        "Use phenix_visualize as a presentation directive when a diagram materially simplifies understanding. Do not repeat the Mermaid source or rendered diagram in the final response; accompany it only with the prose needed to explain the conclusion.",
      parameters: Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 160 }),
          summary: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
          source: Type.String({ minLength: 1, maxLength: 64_000 }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, input) {
        const request = input as {
          readonly title: string;
          readonly summary?: string;
          readonly source: string;
        };
        const artifact = createVisualizationArtifact({
          ...request,
          sourceSessionId,
        });
        if (!published.has(artifact.visualizationId)) {
          published.add(artifact.visualizationId);
          pi.events.emit(VISUALIZATION_EVENT, artifact);
        }
        return {
          content: [{ type: "text" as const, text: VISUAL_ACCEPTED }],
        };
      },
    } as unknown as ToolDefinition);
  };
}
