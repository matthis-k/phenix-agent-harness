import { AGENT_ATTENTION_ROUTER } from "../definitions/ids.ts";
import type {
  AttentionCandidate,
  AttentionDeliveredData,
  AttentionDeliveryDeferredData,
  AttentionDeliveryFailedData,
  AttentionDeliveryOutcome,
  AttentionEnvelope,
  AttentionId,
  AttentionResult,
  AttentionRoutedData,
  AttentionRoutingDecision,
  AttentionRoutingFailedData,
  AttentionRoutingRequest,
  AttentionSubmitRequest,
  AttentionTarget,
} from "../domain/attention/model.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { DomainEvent, PendingDomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunRecord } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { AttentionFacade, ExecutionFacade } from "./interfaces.ts";
import { KeyedSerialExecutor } from "./keyed-serial-executor.ts";

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_ROUTING_CANDIDATES = 32;
const MAX_TARGETS = 8;
const MUTATION_TOOLS = new Set(["edit", "write", "bash"]);

export interface AttentionRouterResult {
  readonly decision: AttentionRoutingDecision;
  readonly routerRunId?: RunId;
}

export interface AttentionRouter {
  route(rootRunId: RunId, request: AttentionRoutingRequest): Promise<AttentionRouterResult>;
}

export class AgentAttentionRouter implements AttentionRouter {
  private readonly execution: ExecutionFacade;

  constructor(execution: ExecutionFacade) {
    this.execution = execution;
  }

  async route(rootRunId: RunId, request: AttentionRoutingRequest): Promise<AttentionRouterResult> {
    const handle = await this.execution.start({
      parentId: rootRunId,
      definition: definitionRef(AGENT_ATTENTION_ROUTER),
      input: request,
      wait: "await",
    });
    const outcome = await handle.result();
    if (outcome.status === "failure") {
      throw new Error(`Attention router failed: ${outcome.failure.message}`);
    }
    if (outcome.status === "cancelled") {
      throw new Error(`Attention router was cancelled: ${outcome.reason}`);
    }
    return {
      decision: outcome.value as AttentionRoutingDecision,
      routerRunId: handle.id,
    };
  }
}

interface PendingDelivery {
  readonly attentionId: AttentionId;
  readonly rootRunId: RunId;
  readonly message: string;
  readonly target: AttentionTarget;
}

export class AttentionProcessManager implements AttentionFacade {
  private readonly execution: ExecutionFacade;
  private readonly store: ExecutionStore;
  private readonly router: AttentionRouter;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly notifyRoot?: (message: string) => void | Promise<void>;
  private readonly serial = new KeyedSerialExecutor<RunId>();
  private readonly pendingByRun = new Map<RunId, Map<AttentionId, PendingDelivery>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(input: {
    readonly execution: ExecutionFacade;
    readonly store: ExecutionStore;
    readonly router?: AttentionRouter;
    readonly ids: IdGenerator;
    readonly clock: Clock;
    readonly notifyRoot?: (message: string) => void | Promise<void>;
  }) {
    this.execution = input.execution;
    this.store = input.store;
    this.router = input.router ?? new AgentAttentionRouter(input.execution);
    this.ids = input.ids;
    this.clock = input.clock;
    this.notifyRoot = input.notifyRoot;
    this.unsubscribe = this.store.events.subscribe((event) => this.onDomainEvent(event));
  }

  hasActiveTargets(rootRunId: RunId): boolean {
    return this.candidates(rootRunId).length > 0;
  }

  submit(request: AttentionSubmitRequest): Promise<AttentionResult> {
    if (this.closed) return Promise.reject(new Error("Attention runtime is shut down"));
    return this.serial.run(request.rootRunId, () => this.submitSerial(request));
  }

  async recover(rootRunId: RunId): Promise<void> {
    const envelopes = new Map<AttentionId, AttentionEnvelope>();
    const deferred = new Map<string, PendingDelivery>();
    const events = this.store.projection.events.filter((event) => event.rootRunId === rootRunId);

    for (const event of events) {
      if (event.type === "attention.received") {
        const envelope = (event.data as { readonly envelope: AttentionEnvelope }).envelope;
        envelopes.set(envelope.id, envelope);
        continue;
      }
      if (event.type === "attention.delivery.deferred") {
        const data = event.data as AttentionDeliveryDeferredData;
        const envelope = envelopes.get(data.attentionId);
        if (!envelope) continue;
        deferred.set(deliveryKey(data.attentionId, data.target.runId), {
          attentionId: data.attentionId,
          rootRunId,
          message: envelope.message,
          target: data.target,
        });
        continue;
      }
      if (event.type === "attention.delivered" || event.type === "attention.delivery.failed") {
        const data = event.data as AttentionDeliveredData | AttentionDeliveryFailedData;
        deferred.delete(deliveryKey(data.attentionId, data.target.runId));
      }
    }

    for (const pending of deferred.values()) {
      const run = this.store.projection.runs.get(pending.target.runId);
      if (!run || isTerminalRunState(run.state) || run.state === "completing") continue;
      this.enqueue(pending);
    }
    for (const runId of this.pendingByRun.keys()) {
      await this.serial.run(rootRunId, () => this.flushRun(runId));
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    await Promise.allSettled([...this.inFlight]);
    this.pendingByRun.clear();
  }

  private async submitSerial(request: AttentionSubmitRequest): Promise<AttentionResult> {
    const root = this.store.projection.requireRun(request.rootRunId);
    if (root.kind !== "root") throw new Error(`${request.rootRunId} is not a root run`);
    const message = request.message.trim();
    if (!message) throw new Error("Attention message must not be empty");
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Attention message must not exceed ${MAX_MESSAGE_LENGTH} characters`);
    }

    const attentionId = this.ids.next("attention") as AttentionId;
    const envelope: AttentionEnvelope = {
      id: attentionId,
      rootRunId: request.rootRunId,
      source: request.source ?? { kind: "user" },
      message,
      receivedAt: this.clock.now(),
    };
    await this.commit(request.rootRunId, "attention.received", { envelope });

    const candidates = this.candidates(request.rootRunId);
    const explicitTargets = this.explicitTargets(request.targetRunIds, message, candidates);
    let routedBy: AttentionResult["routedBy"] = explicitTargets.length > 0 ? "explicit" : "none";
    let routerRunId: RunId | undefined;
    let targets = explicitTargets;

    if (targets.length === 0 && candidates.length > 0 && request.targetRunIds === undefined) {
      try {
        const routed = await this.router.route(request.rootRunId, { message, candidates });
        routerRunId = routed.routerRunId;
        targets = this.validateTargets(routed.decision, candidates);
        routedBy = "model";
      } catch (error) {
        const reason = errorMessage(error);
        await this.commit(request.rootRunId, "attention.routing.failed", {
          attentionId,
          reason,
          ...(routerRunId ? { routerRunId } : {}),
        } satisfies AttentionRoutingFailedData);
        await this.notifyRoot?.(
          `Phenix could not route the follow-up to active children: ${reason}`,
        );
        return {
          attentionId,
          routedBy: "none",
          targets: [],
          deliveries: [],
        };
      }
    }

    await this.commit(request.rootRunId, "attention.routed", {
      attentionId,
      routedBy,
      ...(routerRunId ? { routerRunId } : {}),
      targets,
    } satisfies AttentionRoutedData);

    const deliveries: AttentionDeliveryOutcome[] = [];
    for (const target of targets) {
      deliveries.push(
        await this.deliver({
          attentionId,
          rootRunId: request.rootRunId,
          message,
          target,
        }),
      );
    }
    await this.notifyRoot?.(formatRoutingNotice(targets, deliveries));

    return {
      attentionId,
      routedBy,
      ...(routerRunId ? { routerRunId } : {}),
      targets,
      deliveries,
    };
  }

  private candidates(rootRunId: RunId): readonly AttentionCandidate[] {
    const runs = [...this.store.projection.runs.values()]
      .filter(
        (run) =>
          run.kind === "agent" &&
          run.definitionId !== AGENT_ATTENTION_ROUTER &&
          this.store.projection.rootOf(run.id) === rootRunId &&
          !isTerminalRunState(run.state) &&
          run.state !== "completing",
      )
      .sort((left, right) =>
        left.requestedAt === right.requestedAt
          ? left.id.localeCompare(right.id)
          : left.requestedAt.localeCompare(right.requestedAt),
      )
      .slice(0, MAX_ROUTING_CANDIDATES);

    return runs.map((run) => {
      const objective = objectiveFor(run);
      const activity = activityFor(run, this.store);
      return {
        runId: run.id,
        ...(run.parentId ? { parentRunId: run.parentId } : {}),
        definitionId: run.definitionId,
        state: run.state,
        ...(objective ? { objective } : {}),
        ...(activity ? { activity } : {}),
        activeChildRunIds: this.store.projection
          .childrenOf(run.id)
          .filter((child) => !isTerminalRunState(child.state))
          .map((child) => child.id),
        mutationCapable: run.compiled.tools.some((tool) => MUTATION_TOOLS.has(tool)),
      };
    });
  }

  private explicitTargets(
    requested: readonly RunId[] | undefined,
    message: string,
    candidates: readonly AttentionCandidate[],
  ): readonly AttentionTarget[] {
    const allowed = new Set(candidates.map((candidate) => candidate.runId));
    const selected =
      requested ??
      candidates
        .filter((candidate) => message.includes(candidate.runId))
        .map((candidate) => candidate.runId);
    const unique = [...new Set(selected)].slice(0, MAX_TARGETS);
    if (requested) {
      for (const runId of unique) {
        if (!allowed.has(runId)) {
          throw new Error(`Attention target ${runId} is not an active agent`);
        }
      }
    }
    return unique
      .filter((runId) => allowed.has(runId))
      .map((runId) => ({
        runId,
        delivery: "urgent" as const,
        reason: requested ? "Explicit operator target" : "Run ID named in follow-up",
      }));
  }

  private validateTargets(
    decision: AttentionRoutingDecision,
    candidates: readonly AttentionCandidate[],
  ): readonly AttentionTarget[] {
    const allowed = new Set(candidates.map((candidate) => candidate.runId));
    const targets: AttentionTarget[] = [];
    const seen = new Set<RunId>();
    for (const target of decision.targets.slice(0, MAX_TARGETS)) {
      if (!allowed.has(target.runId) || seen.has(target.runId)) continue;
      const reason = target.reason.trim();
      if (!reason) continue;
      seen.add(target.runId);
      targets.push({
        runId: target.runId,
        delivery: target.delivery,
        reason: reason.slice(0, 240),
      });
    }
    return targets;
  }

  private async deliver(pending: PendingDelivery): Promise<AttentionDeliveryOutcome> {
    const run = this.store.projection.runs.get(pending.target.runId);
    if (!this.isEligibleTarget(run, pending.rootRunId)) {
      return this.failDelivery(pending, "Target is no longer an active agent");
    }
    if (run.state === "created" || run.state === "starting") {
      return this.deferDelivery(pending, `Target is ${run.state}`);
    }
    return this.sendToRun(pending, run, false);
  }

  private async sendToRun(
    pending: PendingDelivery,
    run: RunRecord,
    deferred: boolean,
  ): Promise<AttentionDeliveryOutcome> {
    try {
      if (pending.target.delivery === "next_turn") {
        await this.execution.notify(run.id, pending.message);
      } else {
        await this.execution.send(run.id, pending.message);
      }
      this.removePending(run.id, pending.attentionId);
      await this.commit(pending.rootRunId, "attention.delivered", {
        attentionId: pending.attentionId,
        target: pending.target,
        deferred,
      } satisfies AttentionDeliveredData);
      await this.notifyParent(run, pending);
      return {
        runId: run.id,
        delivery: pending.target.delivery,
        status: "delivered",
      };
    } catch (error) {
      const latest = this.store.projection.runs.get(run.id);
      if (latest && this.isEligibleTarget(latest, pending.rootRunId) && !latest.pi) {
        return this.deferDelivery(pending, "Target session is not bound yet");
      }
      return this.failDelivery(pending, errorMessage(error));
    }
  }

  private async deferDelivery(
    pending: PendingDelivery,
    reason: string,
  ): Promise<AttentionDeliveryOutcome> {
    this.enqueue(pending);
    await this.commit(pending.rootRunId, "attention.delivery.deferred", {
      attentionId: pending.attentionId,
      target: pending.target,
      reason,
    } satisfies AttentionDeliveryDeferredData);
    return {
      runId: pending.target.runId,
      delivery: pending.target.delivery,
      status: "deferred",
      reason,
    };
  }

  private async failDelivery(
    pending: PendingDelivery,
    reason: string,
  ): Promise<AttentionDeliveryOutcome> {
    this.removePending(pending.target.runId, pending.attentionId);
    await this.commit(pending.rootRunId, "attention.delivery.failed", {
      attentionId: pending.attentionId,
      target: pending.target,
      reason,
    } satisfies AttentionDeliveryFailedData);
    return {
      runId: pending.target.runId,
      delivery: pending.target.delivery,
      status: "failed",
      reason,
    };
  }

  private async flushRun(runId: RunId): Promise<void> {
    const queued = [...(this.pendingByRun.get(runId)?.values() ?? [])];
    for (const pending of queued) {
      const run = this.store.projection.runs.get(runId);
      if (!this.isEligibleTarget(run, pending.rootRunId)) {
        await this.failDelivery(pending, "Deferred target became terminal or inaccessible");
        continue;
      }
      if (run.state === "created" || run.state === "starting" || !run.pi) continue;
      await this.sendToRun(pending, run, true);
    }
  }

  private async notifyParent(run: RunRecord, pending: PendingDelivery): Promise<void> {
    if (!run.parentId) return;
    const parent = this.store.projection.runs.get(run.parentId);
    if (parent?.kind !== "agent" || isTerminalRunState(parent.state)) return;
    try {
      await this.execution.notify(
        parent.id,
        `User follow-up ${pending.attentionId} was routed to child ${run.id}. Account for the revised child result before completing your own run.`,
      );
    } catch {
      // Child steering remains authoritative even when the parent notice cannot be delivered yet.
    }
  }

  private onDomainEvent(event: DomainEvent): void {
    if (this.closed) return;
    if (event.type === "run.input.amended") {
      const text = (event.data as { readonly text?: unknown }).text;
      if (typeof text !== "string" || !this.hasActiveTargets(event.rootRunId)) return;
      this.launch(
        this.submit({
          rootRunId: event.rootRunId,
          message: text,
          source: { kind: "user" },
        }),
      );
      return;
    }

    if (event.type === "run.pi.bound" || event.type === "run.state.changed") {
      if (!this.pendingByRun.has(event.runId)) return;
      this.launch(this.serial.run(event.rootRunId, () => this.flushRun(event.runId)));
      return;
    }

    if (isTerminalEvent(event.type) && this.pendingByRun.has(event.runId)) {
      this.launch(this.serial.run(event.rootRunId, () => this.flushRun(event.runId)));
    }
  }

  private launch(operation: Promise<unknown>): void {
    const tracked = operation.then(
      () => undefined,
      async (error: unknown) => {
        try {
          await this.notifyRoot?.(`Phenix attention routing failed: ${errorMessage(error)}`);
        } catch {
          // Attention failure reporting must not create an unhandled rejection.
        }
      },
    );
    this.inFlight.add(tracked);
    void tracked.then(() => this.inFlight.delete(tracked));
  }

  private enqueue(pending: PendingDelivery): void {
    const byAttention = this.pendingByRun.get(pending.target.runId) ?? new Map();
    byAttention.set(pending.attentionId, pending);
    this.pendingByRun.set(pending.target.runId, byAttention);
  }

  private removePending(runId: RunId, attentionId: AttentionId): void {
    const queued = this.pendingByRun.get(runId);
    if (!queued) return;
    queued.delete(attentionId);
    if (queued.size === 0) this.pendingByRun.delete(runId);
  }

  private isEligibleTarget(run: RunRecord | undefined, rootRunId: RunId): run is RunRecord {
    return Boolean(
      run &&
        run.kind === "agent" &&
        run.definitionId !== AGENT_ATTENTION_ROUTER &&
        this.store.projection.rootOf(run.id) === rootRunId &&
        !isTerminalRunState(run.state) &&
        run.state !== "completing",
    );
  }

  private commit(rootRunId: RunId, type: string, data: unknown): Promise<readonly DomainEvent[]> {
    const event: PendingDomainEvent = { runId: rootRunId, type, data };
    return this.store.commit(rootRunId, [event]);
  }
}

function objectiveFor(run: RunRecord): string | undefined {
  if (!run.input || typeof run.input !== "object") return undefined;
  const input = run.input as Readonly<Record<string, unknown>>;
  for (const key of ["objective", "summary", "instruction", "question"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 320);
  }
  return undefined;
}

function activityFor(run: RunRecord, store: ExecutionStore): string | undefined {
  const activity = store.projection.activities.get(run.id);
  if (!activity) return undefined;
  const target = activity.target ? ` (${activity.target})` : "";
  return `${activity.phase}: ${activity.summary}${target}`.slice(0, 320);
}

function formatRoutingNotice(
  targets: readonly AttentionTarget[],
  deliveries: readonly AttentionDeliveryOutcome[],
): string {
  if (targets.length === 0) {
    return "Follow-up kept with the root supervisor; no active child was selected for steering.";
  }
  const status = new Map(deliveries.map((delivery) => [delivery.runId, delivery.status]));
  return `Follow-up routed to ${targets
    .map(
      (target) => `${target.runId} (${target.delivery}, ${status.get(target.runId) ?? "unknown"})`,
    )
    .join(", ")}.`;
}

function deliveryKey(attentionId: AttentionId, runId: RunId): string {
  return `${attentionId}\u0000${runId}`;
}

function isTerminalEvent(type: string): boolean {
  return ["run.completed", "run.failed", "run.cancelled", "run.orphaned"].includes(type);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
