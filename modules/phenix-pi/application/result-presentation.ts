import type { AgentToolResult } from "../ports/agent-session-backend.ts";
import { structuredContentMarkdownTransform } from "./structured-content-markdown.ts";

export type ResultTransform = "auto" | "structured-content-markdown" | "mermaid-source";
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

export interface ResultTransformStrategy {
  readonly id: ResolvedResultTransform;
  readonly auto: boolean;
  transform(contract: unknown): ResultRenderInput | undefined;
}

export interface ResultRendererDefinition {
  readonly id: ResolvedResultRenderer;
  readonly inputKind: ResultRenderInput["kind"] | "any";
  readonly auto: boolean;
  readonly native: boolean;
}

export type ResultPresenter = (
  result: AgentToolResult,
  request?: ResultPresentationRequest,
) => AgentToolResult;

export const mermaidSourceTransform: ResultTransformStrategy = {
  id: "mermaid-source",
  auto: false,
  transform(contract) {
    const source = mermaidSource(contract);
    return source ? { kind: "mermaid", source } : undefined;
  },
};

export const defaultResultRendererDefinitions: readonly ResultRendererDefinition[] = [
  { id: "tool", inputKind: "any", auto: false, native: false },
  { id: "pi-markdown", inputKind: "markdown", auto: true, native: true },
  { id: "beautiful-mermaid", inputKind: "mermaid", auto: true, native: true },
];

export const defaultResultTransformStrategies: readonly ResultTransformStrategy[] = [
  structuredContentMarkdownTransform,
  mermaidSourceTransform,
];

export const presentRootResult = createResultPresenter({
  transforms: defaultResultTransformStrategies,
  renderers: defaultResultRendererDefinitions,
});

export function createResultPresenter(input: {
  readonly transforms: readonly ResultTransformStrategy[];
  readonly renderers: readonly ResultRendererDefinition[];
}): ResultPresenter {
  const transforms = uniqueById(input.transforms, "transform");
  const renderers = uniqueById(input.renderers, "renderer");

  return (result, request = {}) => {
    const transformation = resolveTransformation(
      presentationContract(result.details),
      request.transform ?? "auto",
      transforms,
    );
    const requestedRenderer = request.renderer ?? "auto";

    if (!transformation) {
      if (requestedRenderer !== "auto" && requestedRenderer !== "tool") {
        throw new Error(
          `Renderer ${requestedRenderer} requires a compatible result transform; no automatic transform matched this contract`,
        );
      }
      return result;
    }

    const renderer = resolveRenderer(requestedRenderer, transformation.input, renderers);
    const details = withPresentationMetadata(result.details, {
      transform: transformation.id,
      renderer: renderer.id,
      inputKind: transformation.input.kind,
    });
    const { terminate: _terminate, ...base } = result;

    return {
      ...base,
      text: renderInputSource(transformation.input),
      details,
      ...(renderer.native ? { terminate: true } : {}),
    };
  };
}

export function transformResult(
  contract: unknown,
  transform: ResultTransform,
  strategies: readonly ResultTransformStrategy[] = defaultResultTransformStrategies,
): ResultTransformation | undefined {
  return resolveTransformation(presentationContract(contract), transform, strategies);
}

function resolveTransformation(
  contract: unknown,
  requested: ResultTransform,
  strategies: readonly ResultTransformStrategy[],
): ResultTransformation | undefined {
  if (requested === "auto") {
    for (const strategy of strategies) {
      if (!strategy.auto) continue;
      const transformed = strategy.transform(contract);
      if (transformed) return { id: strategy.id, input: transformed };
    }
    return undefined;
  }

  const strategy = strategies.find((candidate) => candidate.id === requested);
  if (!strategy) throw new Error(`Unknown result transform: ${requested}`);
  const transformed = strategy.transform(contract);
  if (!transformed) throw new Error(`Transform ${requested} does not accept this result contract`);
  return { id: strategy.id, input: transformed };
}

function resolveRenderer(
  requested: ResultRenderer,
  renderInput: ResultRenderInput,
  renderers: readonly ResultRendererDefinition[],
): ResultRendererDefinition {
  const renderer =
    requested === "auto"
      ? renderers.find(
          (candidate) => candidate.auto && rendererAccepts(candidate, renderInput.kind),
        )
      : renderers.find((candidate) => candidate.id === requested);
  if (!renderer) throw new Error(`Unknown or unavailable result renderer: ${requested}`);
  if (!rendererAccepts(renderer, renderInput.kind)) {
    throw new Error(`Renderer ${renderer.id} cannot render ${renderInput.kind} input`);
  }
  return renderer;
}

function rendererAccepts(
  renderer: ResultRendererDefinition,
  inputKind: ResultRenderInput["kind"],
): boolean {
  return renderer.inputKind === "any" || renderer.inputKind === inputKind;
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

function presentationContract(value: unknown): unknown {
  const record = recordOf(value);
  if (!record) return value;
  if (record.outcome !== undefined) return presentationContract(record.outcome);
  if (record.status === "success" && record.value !== undefined) {
    return presentationContract(record.value);
  }
  return record.document ?? record.value ?? value;
}

function mermaidSource(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const root = recordOf(value);
  if (!root) return undefined;
  const candidates = [root.source, recordOf(root.value)?.source, recordOf(root.document)?.source];
  return candidates
    .find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    )
    ?.trim();
}

function uniqueById<T extends { readonly id: string }>(
  values: readonly T[],
  kind: string,
): readonly T[] {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`Duplicate result ${kind} ${value.id}`);
    ids.add(value.id);
  }
  return values;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
