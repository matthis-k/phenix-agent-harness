import type { AgentToolResult } from "../ports/agent-session-backend.ts";

export type ResultTransform = "auto" | "qa-report" | "mermaid-source";
export type ResultRenderer = "auto" | "tool" | "pi-markdown" | "beautiful-mermaid";
export type ResolvedResultTransform = Exclude<ResultTransform, "auto">;
export type ResolvedResultRenderer = Exclude<ResultRenderer, "auto">;
export type ResultRenderInput =
  | { readonly kind: "markdown"; readonly content: string }
  | { readonly kind: "mermaid"; readonly source: string };

export interface ResultPresentationRequest {
  readonly transform?: ResultTransform;
  readonly renderer?: ResultRenderer;
}

export interface ResultPresentationMetadata {
  readonly transform: ResolvedResultTransform;
  readonly renderer: ResolvedResultRenderer;
  readonly inputKind: ResultRenderInput["kind"];
}

export interface ResultTransformation {
  readonly id: ResolvedResultTransform;
  readonly input: ResultRenderInput;
}

interface ResultTransformDefinition {
  readonly id: ResolvedResultTransform;
  readonly auto: boolean;
  transform(result: AgentToolResult, contract: unknown): ResultRenderInput | undefined;
}

const QA_REPORT_HEADING = "## QA report\n";
const TRANSFORMS: readonly ResultTransformDefinition[] = [
  {
    id: "qa-report",
    auto: true,
    transform: qaReportInput,
  },
  {
    id: "mermaid-source",
    auto: false,
    transform: mermaidSourceInput,
  },
];

export function presentRootResult(
  result: AgentToolResult,
  request: ResultPresentationRequest = {},
): AgentToolResult {
  const transformation = resolveTransformation(result, request.transform ?? "auto");
  const requestedRenderer = request.renderer ?? "auto";

  if (!transformation) {
    if (requestedRenderer !== "auto" && requestedRenderer !== "tool") {
      throw new Error(
        `Renderer ${requestedRenderer} requires a compatible result transform; no automatic transform matched this contract`,
      );
    }
    return result;
  }

  const renderer = resolveRenderer(requestedRenderer, transformation.input);
  assertRendererCompatible(renderer, transformation.input);
  const details = withPresentationMetadata(result.details, {
    transform: transformation.id,
    renderer,
    inputKind: transformation.input.kind,
  });
  const { terminate: _terminate, ...base } = result;

  return {
    ...base,
    text: renderInputSource(transformation.input),
    details,
    ...(renderer === "tool" ? {} : { terminate: true }),
  };
}

export function isDeterministicQaPresentation(result: AgentToolResult): boolean {
  return qaReportInput(result, contractData(result.details)) !== undefined;
}

export function transformResult(
  result: AgentToolResult,
  transform: ResultTransform,
): ResultTransformation | undefined {
  return resolveTransformation(result, transform);
}

function resolveTransformation(
  result: AgentToolResult,
  requested: ResultTransform,
): ResultTransformation | undefined {
  const contract = contractData(result.details);
  if (requested === "auto") {
    for (const definition of TRANSFORMS) {
      if (!definition.auto) continue;
      const input = definition.transform(result, contract);
      if (input) return { id: definition.id, input };
    }
    return undefined;
  }

  const definition = TRANSFORMS.find((candidate) => candidate.id === requested);
  if (!definition) throw new Error(`Unknown result transform: ${requested}`);
  const input = definition.transform(result, contract);
  if (!input) throw new Error(`Transform ${requested} does not accept this result contract`);
  return { id: definition.id, input };
}

function qaReportInput(result: AgentToolResult, contract: unknown): ResultRenderInput | undefined {
  if (!result.text.startsWith(QA_REPORT_HEADING)) return undefined;
  const envelope = recordOf(contract);
  const outcome = recordOf(envelope?.outcome) ?? envelope;
  if (
    outcome?.status !== "success" ||
    !Array.isArray(outcome.checks) ||
    !Array.isArray(outcome.findings)
  ) {
    return undefined;
  }
  return { kind: "markdown", content: result.text };
}

function mermaidSourceInput(
  _result: AgentToolResult,
  contract: unknown,
): ResultRenderInput | undefined {
  const source = mermaidSource(contract);
  return source ? { kind: "mermaid", source } : undefined;
}

function mermaidSource(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const root = recordOf(value);
  if (!root) return undefined;

  const candidates = [
    root.source,
    recordOf(root.value)?.source,
    recordOf(root.outcome)?.source,
    recordOf(recordOf(root.outcome)?.value)?.source,
  ];
  return candidates.find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
  )?.trim();
}

function resolveRenderer(
  requested: ResultRenderer,
  input: ResultRenderInput,
): ResolvedResultRenderer {
  if (requested !== "auto") return requested;
  return input.kind === "markdown" ? "pi-markdown" : "beautiful-mermaid";
}

function assertRendererCompatible(
  renderer: ResolvedResultRenderer,
  input: ResultRenderInput,
): void {
  if (renderer === "tool") return;
  if (renderer === "pi-markdown" && input.kind === "markdown") return;
  if (renderer === "beautiful-mermaid" && input.kind === "mermaid") return;
  throw new Error(`Renderer ${renderer} cannot render ${input.kind} input`);
}

function renderInputSource(input: ResultRenderInput): string {
  return input.kind === "markdown" ? input.content : input.source;
}

function withPresentationMetadata(
  details: unknown,
  presentation: ResultPresentationMetadata,
): unknown {
  const record = recordOf(details);
  const transport = recordOf(record?.transport);
  if (record) {
    return {
      ...record,
      transport: {
        ...(transport ?? {}),
        presentation,
      },
    };
  }
  return {
    value: details,
    transport: { presentation },
  };
}

function contractData(details: unknown): unknown {
  const record = recordOf(details);
  if (!record) return details;
  const { transport: _transport, ...contract } = record;
  return contract;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
