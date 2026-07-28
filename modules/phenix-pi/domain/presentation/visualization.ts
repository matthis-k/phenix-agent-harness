import { createHash } from "node:crypto";

export const VISUALIZATION_EVENT = "phenix:visualization-published";
export const VISUALIZATION_ENTRY_TYPE = "phenix:visualization";

const MAX_MERMAID_SOURCE_LENGTH = 64_000;
const SUPPORTED_MERMAID_HEADER =
  /^(?:flowchart|graph|statediagram|sequencediagram|classdiagram|erdiagram|xychart)/;

export interface VisualizationArtifact {
  readonly visualizationId: string;
  readonly title: string;
  readonly summary: string;
  readonly source: string;
  readonly sourceSessionId: string;
  readonly renderer: "beautiful-mermaid";
}

export function createVisualizationArtifact(input: {
  readonly title: string;
  readonly summary?: string;
  readonly source: string;
  readonly sourceSessionId: string;
}): VisualizationArtifact {
  const title = input.title.trim();
  if (!title) throw new Error("Visualization title must not be empty");
  const source = requireMermaidSource(input.source);
  const summary = input.summary?.trim() || `Visual explanation: ${title}`;
  const normalized = JSON.stringify({
    title,
    summary,
    source,
    sourceSessionId: input.sourceSessionId,
  });
  return {
    visualizationId: `visualization-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`,
    title,
    summary,
    source,
    sourceSessionId: input.sourceSessionId,
    renderer: "beautiful-mermaid",
  };
}

export function isVisualizationArtifact(value: unknown): value is VisualizationArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const artifact = value as Partial<VisualizationArtifact>;
  return (
    typeof artifact.visualizationId === "string" &&
    typeof artifact.title === "string" &&
    typeof artifact.summary === "string" &&
    typeof artifact.source === "string" &&
    typeof artifact.sourceSessionId === "string" &&
    artifact.renderer === "beautiful-mermaid"
  );
}

export function requireMermaidSource(source: string): string {
  const normalized = normalizeMermaidSource(source);
  if (!normalized) throw new Error("Mermaid source must not be empty");
  if (normalized.length > MAX_MERMAID_SOURCE_LENGTH) {
    throw new Error(`Mermaid source exceeds ${MAX_MERMAID_SOURCE_LENGTH} characters`);
  }
  const header = normalized.split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? "";
  if (!SUPPORTED_MERMAID_HEADER.test(header)) {
    throw new Error(
      "Unsupported Mermaid diagram. Use flowchart, graph, stateDiagram, sequenceDiagram, classDiagram, erDiagram, or xychart.",
    );
  }
  return normalized;
}

function normalizeMermaidSource(source: string): string {
  const trimmed = source.trim();
  const fenced = trimmed.match(/^```(?:mermaid)?\s*\n([\s\S]*?)\n```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}
