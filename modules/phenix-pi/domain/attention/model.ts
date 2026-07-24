import type { DefinitionId, RunId } from "../shared.ts";
import type { RunState } from "../run/model.ts";

export type AttentionId = string & { readonly __brand: "AttentionId" };
export type AttentionDelivery = "urgent" | "next_turn";

export type AttentionSource =
  | { readonly kind: "user" }
  | { readonly kind: "operator" }
  | { readonly kind: "run"; readonly runId: RunId };

export interface AttentionEnvelope {
  readonly id: AttentionId;
  readonly rootRunId: RunId;
  readonly source: AttentionSource;
  readonly message: string;
  readonly receivedAt: string;
}

export interface AttentionCandidate {
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly definitionId: DefinitionId;
  readonly state: RunState;
  readonly objective?: string;
  readonly activity?: string;
  readonly activeChildRunIds: readonly RunId[];
  readonly mutationCapable: boolean;
}

export interface AttentionTarget {
  readonly runId: RunId;
  readonly delivery: AttentionDelivery;
  readonly reason: string;
}

export interface AttentionRoutingRequest {
  readonly message: string;
  readonly candidates: readonly AttentionCandidate[];
}

export interface AttentionRoutingDecision {
  readonly targets: readonly AttentionTarget[];
  readonly reason: string;
}

export interface AttentionSubmitRequest {
  readonly rootRunId: RunId;
  readonly message: string;
  readonly source?: AttentionSource;
  readonly targetRunIds?: readonly RunId[];
}

export interface AttentionDeliveryOutcome {
  readonly runId: RunId;
  readonly delivery: AttentionDelivery;
  readonly status: "delivered" | "deferred" | "failed";
  readonly reason?: string;
}

export interface AttentionResult {
  readonly attentionId: AttentionId;
  readonly routedBy: "explicit" | "model" | "none";
  readonly routerRunId?: RunId;
  readonly targets: readonly AttentionTarget[];
  readonly deliveries: readonly AttentionDeliveryOutcome[];
}

export interface AttentionReceivedData {
  readonly envelope: AttentionEnvelope;
}

export interface AttentionRoutedData {
  readonly attentionId: AttentionId;
  readonly routedBy: AttentionResult["routedBy"];
  readonly routerRunId?: RunId;
  readonly targets: readonly AttentionTarget[];
}

export interface AttentionRoutingFailedData {
  readonly attentionId: AttentionId;
  readonly reason: string;
  readonly routerRunId?: RunId;
}

export interface AttentionDeliveryDeferredData {
  readonly attentionId: AttentionId;
  readonly target: AttentionTarget;
  readonly reason: string;
}

export interface AttentionDeliveredData {
  readonly attentionId: AttentionId;
  readonly target: AttentionTarget;
  readonly deferred: boolean;
}

export interface AttentionDeliveryFailedData {
  readonly attentionId: AttentionId;
  readonly target: AttentionTarget;
  readonly reason: string;
}
