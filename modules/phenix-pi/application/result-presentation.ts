import type { StructuredDocument } from "../domain/presentation/structured-content.ts";
import type { AgentToolResult } from "../ports/agent-session-backend.ts";
import { qaReportStructuredContentStep } from "./qa-report-structured-content.ts";
import {
  structuredContentContractStep,
  structuredContentMarkdownStep,
} from "./structured-content-markdown.ts";

export type ResultTransform =
  | "auto"
  | "qa-report"
  | "structured-content-markdown"
  | "mermaid-source";
export type ResultRenderer = "auto" | "tool" | "pi-markdown" | "beautiful-mermaid";
export type ResolvedResultTransform = Exclude<ResultTransform, "auto">;
export type ResolvedResultRenderer = Exclude<ResultRenderer, "auto">;

export type ResultRenderInput =
  | { readonly kind: "markdown"; readonly content: string }
  | { readonly kind: "mermaid"; readonly source: string };

export type ResultTransformValue =
  | { readonly kind: "contract"; readonly value: unknown }
  | { readonly kind: "structured-content"; readonly document: StructuredDocument }
  | ResultRenderInput;

export interface ResultPresentationRequest {
  readonly transform?: ResultTransform;
  readonly renderer?: ResultRenderer;
}

export interface ResultPresentationMetadata {
  readonly transform: ResolvedResultTransform;
  readonly steps: readonly string[];
  readonly renderer: ResolvedResultRenderer;
  readonly inputKind: ResultRenderInput["kind"];
}

export interface ResultTransformation {
  readonly id: ResolvedResultTransform;
  readonly steps: readonly string[];
  readonly input: ResultRenderInput;
}

export interface ResultTransformStep {
  readonly id: string;
  readonly inputKind: ResultTransformValue["kind"];
  readonly outputKind: ResultTransformValue["kind"];
  transform(input: ResultTransformValue): ResultTransformValue | undefined;
}

export interface ResultTransformStrategy {
  readonly id: ResolvedResultTransform;
  readonly auto: boolean;
  readonly steps: readonly ResultTransformStep[];
}

export interface ResultRendererStrategy {
  readonly id: ResolvedResultRenderer;
  readonly auto: boolean;
  readonly native: boolean;
  accepts(input: ResultRenderInput): boolean;
}

export type ResultPresenter = (
  result: AgentToolResult,
  request?: ResultPresentationRequest,
) => AgentToolResult;

const mermaidSourceStep: ResultTransformStep = {
  id: "mermaid-source",
  inputKind: "contract",
  outputKind: "mermaid",
  transform(input) {
    if (input.kind !== "contract") return undefined;
    const source = mermaidSource(input.value);
    return source ? { kind: "mermaid", source } : undefined;
  },
};

export const qaReportTransform = composeResultTransformStrategy({
  id: "qa-report",
  auto: true,
  steps: [qaReportStructuredContentStep, structuredContentMarkdownStep],
});

export const structuredContentMarkdownTransform = composeResultTransformStrategy({
  id: "structured-content-markdown",
  auto: true,
  steps: [structuredContentContractStep, structuredContentMarkdownStep],
});

export const mermaidSourceTransform = composeResultTransformStrategy({
  id: "mermaid-source",
  auto: false,
  steps: [mermaidSourceStep],
});

export const defaultResultTransformStrategies: readonly ResultTransformStrategy[] = [
  qaReportTransform,
  structuredContentMarkdownTransform,
  mermaidSourceTransform,
];

export const defaultResultRendererStrategies: readonly ResultRendererStrategy[] = [
  {
    id: "tool",
    auto: false,
    native: false,
    accepts: () => true,
  },
  {
    id: "pi-markdown",
    auto: true,
    native: true,
    accepts: (input) => input.kind === "markdown",
  },
  {
    id: "beautiful-mermaid",
    auto: true,
    native: true,
    accepts: (input) => input.kind === "mermaid",
  },
];

export const presentRootResult = createResultPresenter({
  transforms: defaultResultTransformStrategies,
  renderers: defaultResultRendererStrategies,
});

export function composeResultTransformStrategy(input: {
  readonly id: ResolvedResultTransform;
  readonly auto: boolean;
  readonly steps: readonly ResultTransformStep[];
}): ResultTransformStrategy {
  if (input.steps.length === 0) throw new Error(`Result transform ${input.id} has no steps`);
  if (input.steps[0]?.inputKind !== "contract") {
    throw new Error(`Result transform ${input.id} must start from contract data`);
  }
  for (let index = 1; index < input.steps.length; index += 1) {
    const previous = input.steps[index - 1];
    const current = input.steps[index];
    if (previous?.outputKind !== current?.inputKind) {
      throw new Error(
        `Result transform ${input.id} cannot compose ${previous?.id} (${previous?.outputKind}) with ${current?.id} (${current?.inputKind})`,
      );
    }
  }
  const outputKind = input.steps.at(-1)?.outputKind;
  if (outputKind !== "markdown" && outputKind !== "mermaid") {
    throw new Error(`Result transform ${input.id} must produce renderer input`);
  }
  return input;
}

export function createResultPresenter(input: {
  readonly transforms: readonly ResultTransformStrategy[];
  readonly renderers: readonly ResultRendererStrategy[];
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
      steps: transformation.steps,
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
  resultOrContract: unknown,
  transform: ResultTransform,
  strategies: readonly ResultTransformStrategy[] = defaultResultTransformStrategies,
): ResultTransformation | undefined {
  return resolveTransformation(
    presentationContract(toolResultDetails(resultOrContract)),
    transform,
    strategies,
  );
}

function resolveTransformation(
  contract: unknown,
  requested: ResultTransform,
  strategies: readonly ResultTransformStrategy[],
): ResultTransformation | undefined {
  if (requested === "auto") {
    for (const strategy of strategies) {
      if (!strategy.auto) continue;
      const transformed = runTransformStrategy(strategy, contract);
      if (transformed) return transformed;
    }
    return undefined;
  }

  const strategy = strategies.find((candidate) => candidate.id === requested);
  if (!strategy) throw new Error(`Unknown result transform: ${requested}`);
  const transformed = runTransformStrategy(strategy, contract);
  if (!transformed) throw new Error(`Transform ${requested} does not accept this result contract`);
  return transformed;
}

function runTransformStrategy(
  strategy: ResultTransformStrategy,
  contract: unknown,
): ResultTransformation | undefined {
  let current: ResultTransformValue = { kind: "contract", value: contract };
  for (const step of strategy.steps) {
    if (current.kind !== step.inputKind) return undefined;
    const transformed = step.transform(current);
    if (!transformed || transformed.kind !== step.outputKind) return undefined;
    current = transformed;
  }
  if (current.kind !== "markdown" && current.kind !== "mermaid") return undefined;
  return {
    id: strategy.id,
    steps: strategy.steps.map((step) => step.id),
    input: current,
  };
}

function resolveRenderer(
  requested: ResultRenderer,
  renderInput: ResultRenderInput,
  renderers: readonly ResultRendererStrategy[],
): ResultRendererStrategy {
  const renderer =
    requested === "auto"
      ? renderers.find((candidate) => candidate.auto && candidate.accepts(renderInput))
      : renderers.find((candidate) => candidate.id === requested);
  if (!renderer) throw new Error(`Unknown or unavailable result renderer: ${requested}`);
  if (!renderer.accepts(renderInput)) {
    throw new Error(`Renderer ${renderer.id} cannot render ${renderInput.kind} input`);
  }
  return renderer;
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

function toolResultDetails(value: unknown): unknown {
  const record = recordOf(value);
  return record && typeof record.text === "string" && "details" in record ? record.details : value;
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
