import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createVisualizationArtifact,
  VISUALIZATION_EVENT,
} from "../../domain/presentation/visualization.ts";

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
      label: "Visualize Architecture",
      description:
        "Publish one Mermaid diagram directly into the root transcript. Use for architecture boundaries, data flow, interaction sequences, state machines, and implementation plans that are materially clearer visually. The user can open the resulting artifact in a full-screen scrollable view with /visual <id>.",
      promptSnippet:
        "Use phenix_visualize when a Mermaid diagram would materially simplify understanding. Keep the accompanying prose concise and ensure the diagram is consistent with the grounded analysis.",
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
        const duplicate = published.has(artifact.visualizationId);
        if (!duplicate) {
          published.add(artifact.visualizationId);
          pi.events.emit(VISUALIZATION_EVENT, artifact);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: duplicate
                ? `Visualization already published: ${artifact.visualizationId}. Open with /visual ${artifact.visualizationId}.`
                : `Published visualization ${artifact.visualizationId}. Open with /visual ${artifact.visualizationId}.`,
            },
          ],
          details: { ...artifact, duplicate },
        };
      },
    } as ToolDefinition);
  };
}
