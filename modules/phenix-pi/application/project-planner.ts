import type {
  DecisionId,
  InterventionId,
  ProjectActor,
  ProjectDecision,
  ProjectDecisionInput,
  ProjectDecisionResolution,
  ProjectDestination,
  ProjectEvent,
  ProjectId,
  ProjectIntervention,
  ProjectMap,
  ProjectTrackerLink,
  UnsequencedProjectEvent,
} from "../domain/project/model.ts";
import { decisionId, interventionId, projectId } from "../domain/project/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { ProjectLedger } from "../ports/project-ledger.ts";
import type { ProjectTracker } from "../ports/project-tracker.ts";
import { KeyedSerialExecutor } from "./keyed-serial-executor.ts";

export interface CreateProjectRequest {
  readonly title: string;
  readonly destination: ProjectDestination;
  readonly notes?: readonly string[];
  readonly fog?: readonly string[];
  readonly decisions?: readonly ProjectDecisionInput[];
}

export interface ResolveDecisionRequest {
  readonly summary: string;
  readonly rationale: string;
  readonly evidence?: readonly string[];
  readonly consequences?: readonly string[];
}

export interface RequestProjectInput {
  readonly question: string;
  readonly context?: string;
  readonly options?: readonly string[];
}

export interface ProjectPlannerFacade {
  list(): Promise<readonly ProjectMap[]>;
  create(request: CreateProjectRequest, actor: ProjectActor): Promise<ProjectMap>;
  inspect(id: ProjectId): Promise<ProjectMap>;
  frontier(id: ProjectId): Promise<readonly ProjectDecision[]>;
  addDecision(id: ProjectId, input: ProjectDecisionInput, actor: ProjectActor): Promise<ProjectMap>;
  updateFog(id: ProjectId, fog: readonly string[], actor: ProjectActor): Promise<ProjectMap>;
  claim(id: ProjectId, decision: DecisionId, actor: ProjectActor): Promise<ProjectMap>;
  release(id: ProjectId, decision: DecisionId, actor: ProjectActor): Promise<ProjectMap>;
  resolve(
    id: ProjectId,
    decision: DecisionId,
    request: ResolveDecisionRequest,
    actor: ProjectActor,
  ): Promise<ProjectMap>;
  markOutOfScope(
    id: ProjectId,
    decision: DecisionId,
    reason: string,
    actor: ProjectActor,
  ): Promise<ProjectMap>;
  requestInput(
    id: ProjectId,
    decision: DecisionId,
    request: RequestProjectInput,
    actor: ProjectActor,
  ): Promise<ProjectIntervention>;
  answerInput(
    id: ProjectId,
    intervention: InterventionId,
    answer: string,
    actor: ProjectActor,
  ): Promise<ProjectIntervention>;
  publish(id: ProjectId, actor: ProjectActor): Promise<ProjectMap>;
  exportSpec(id: ProjectId): Promise<string>;
}

export class ProjectPlannerService implements ProjectPlannerFacade {
  private readonly ledger: ProjectLedger;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly tracker: ProjectTracker | undefined;
  private readonly notifyRoot: ((message: string) => void | Promise<void>) | undefined;
  private readonly deliverToRun: ((runId: RunId, message: string) => Promise<void>) | undefined;
  private readonly serial = new KeyedSerialExecutor<ProjectId>();

  constructor(
    ledger: ProjectLedger,
    ids: IdGenerator,
    clock: Clock,
    tracker?: ProjectTracker,
    notifyRoot?: (message: string) => void | Promise<void>,
    deliverToRun?: (runId: RunId, message: string) => Promise<void>,
  ) {
    this.ledger = ledger;
    this.ids = ids;
    this.clock = clock;
    this.tracker = tracker;
    this.notifyRoot = notifyRoot;
    this.deliverToRun = deliverToRun;
  }

  async list(): Promise<readonly ProjectMap[]> {
    const ids = await this.ledger.list();
    return Promise.all(ids.map((id) => this.inspect(id)));
  }

  async create(request: CreateProjectRequest, actor: ProjectActor): Promise<ProjectMap> {
    validateDestination(request.destination);
    const id = projectId(this.ids.next("project"));
    const now = this.clock.now();
    const decisions = (request.decisions ?? []).map((input) => this.newDecision(input, now));
    validateDecisionGraph(decisions);
    const event: UnsequencedProjectEvent = {
      projectId: id,
      type: "project.created",
      at: now,
      actor,
      data: {
        title: requireText("project title", request.title),
        destination: request.destination,
        notes: cleanList(request.notes ?? []),
        fog: cleanList(request.fog ?? []),
        decisions,
      },
    };
    await this.ledger.append(id, 0, [event]);
    return this.inspect(id);
  }

  async inspect(id: ProjectId): Promise<ProjectMap> {
    const events = await this.ledger.load(id);
    if (events.length === 0) throw new Error(`Unknown project ${id}`);
    return projectFromEvents(events);
  }

  async frontier(id: ProjectId): Promise<readonly ProjectDecision[]> {
    return frontierOf(await this.inspect(id));
  }

  addDecision(
    id: ProjectId,
    input: ProjectDecisionInput,
    actor: ProjectActor,
  ): Promise<ProjectMap> {
    return this.mutate(id, actor, (project) => {
      const decision = this.newDecision(input, this.clock.now());
      if (project.decisions.some((candidate) => candidate.id === decision.id)) {
        throw new Error(`Decision ${decision.id} already exists`);
      }
      validateDecisionGraph([...project.decisions, decision]);
      return { type: "decision.added", data: { decision } };
    });
  }

  updateFog(id: ProjectId, fog: readonly string[], actor: ProjectActor): Promise<ProjectMap> {
    return this.mutate(id, actor, () => ({
      type: "project.fog.updated",
      data: { fog: cleanList(fog) },
    }));
  }

  claim(id: ProjectId, decision: DecisionId, actor: ProjectActor): Promise<ProjectMap> {
    return this.mutate(id, actor, async (project) => {
      const target = requireDecision(project, decision);
      if (!frontierOf(project).some((candidate) => candidate.id === decision)) {
        throw new Error(`Decision ${decision} is not on the current frontier`);
      }
      if (target.state !== "open") {
        throw new Error(`Decision ${decision} cannot be claimed from ${target.state}`);
      }
      await this.tracker?.claim(project, target);
      return { type: "decision.claimed", data: { decisionId: decision } };
    });
  }

  release(id: ProjectId, decision: DecisionId, actor: ProjectActor): Promise<ProjectMap> {
    return this.mutate(id, actor, async (project) => {
      const target = requireDecision(project, decision);
      if (!target.claim || (!sameActor(target.claim.actor, actor) && !isRootActor(actor))) {
        throw new Error(`Decision ${decision} is not controlled by ${actor.runId}`);
      }
      await this.tracker?.release(project, target);
      return { type: "decision.released", data: { decisionId: decision } };
    });
  }

  resolve(
    id: ProjectId,
    decision: DecisionId,
    request: ResolveDecisionRequest,
    actor: ProjectActor,
  ): Promise<ProjectMap> {
    return this.mutate(id, actor, async (project) => {
      const target = requireDecision(project, decision);
      assertClaimOwner(target, actor);
      if (target.state !== "claimed" && target.state !== "awaiting_user") {
        throw new Error(`Decision ${decision} cannot resolve from ${target.state}`);
      }
      const resolution: ProjectDecisionResolution = {
        summary: requireText("resolution summary", request.summary),
        rationale: requireText("resolution rationale", request.rationale),
        evidence: cleanList(request.evidence ?? []),
        consequences: cleanList(request.consequences ?? []),
        resolvedAt: this.clock.now(),
        actor,
      };
      const projected = applySynthetic(project, {
        type: "decision.resolved",
        data: { decisionId: decision, resolution },
      });
      await this.tracker?.resolve(projected, requireDecision(projected, decision));
      await this.tracker?.refresh(projected);
      return { type: "decision.resolved", data: { decisionId: decision, resolution } };
    });
  }

  markOutOfScope(
    id: ProjectId,
    decision: DecisionId,
    reason: string,
    actor: ProjectActor,
  ): Promise<ProjectMap> {
    return this.mutate(id, actor, async (project) => {
      const target = requireDecision(project, decision);
      if (target.state === "resolved" || target.state === "out_of_scope") {
        throw new Error(`Decision ${decision} is already terminal`);
      }
      if (target.claim && !sameActor(target.claim.actor, actor) && !isRootActor(actor)) {
        throw new Error(`Decision ${decision} is not controlled by ${actor.runId}`);
      }
      if (!target.claim && !isRootActor(actor)) {
        throw new Error(`Only the root supervisor may remove an unclaimed decision from scope`);
      }
      const normalizedReason = requireText("out-of-scope reason", reason);
      const projected = applySynthetic(project, {
        type: "decision.out_of_scope",
        data: { decisionId: decision, reason: normalizedReason },
      });
      await this.tracker?.resolve(projected, requireDecision(projected, decision));
      await this.tracker?.refresh(projected);
      return {
        type: "decision.out_of_scope",
        data: { decisionId: decision, reason: normalizedReason },
      };
    });
  }

  async requestInput(
    id: ProjectId,
    decision: DecisionId,
    request: RequestProjectInput,
    actor: ProjectActor,
  ): Promise<ProjectIntervention> {
    let created: ProjectIntervention | undefined;
    await this.mutate(id, actor, (project) => {
      const target = requireDecision(project, decision);
      assertClaimOwner(target, actor);
      if (target.state !== "claimed" && target.state !== "awaiting_user") {
        throw new Error(`Decision ${decision} cannot request input from ${target.state}`);
      }
      created = {
        id: interventionId(this.ids.next("intervention")),
        decisionId: decision,
        requestedBy: actor,
        question: requireText("intervention question", request.question),
        ...(request.context?.trim() ? { context: request.context.trim() } : {}),
        options: cleanList(request.options ?? []),
        requestedAt: this.clock.now(),
        status: "pending",
      };
      return { type: "intervention.requested", data: { intervention: created } };
    });
    if (!created) throw new Error("Intervention was not created");
    const project = await this.inspect(id);
    const target = requireDecision(project, decision);
    await this.notifyRoot?.(
      `Project ${project.title} needs input for ${target.title}: ${created.question} [${created.id}]`,
    );
    return created;
  }

  async answerInput(
    id: ProjectId,
    intervention: InterventionId,
    answer: string,
    actor: ProjectActor,
  ): Promise<ProjectIntervention> {
    if (!isRootActor(actor)) throw new Error("Only the root supervisor may answer project input");
    const response = requireText("intervention answer", answer);
    let answered = false;
    await this.mutate(id, actor, async (project) => {
      const pending = project.interventions.find((candidate) => candidate.id === intervention);
      if (!pending) throw new Error(`Unknown intervention ${intervention}`);
      if (pending.status !== "pending") {
        throw new Error(`Intervention ${intervention} is already answered`);
      }
      let delivered = false;
      if (this.deliverToRun) {
        try {
          await this.deliverToRun(
            pending.requestedBy.runId,
            `Operator response for project intervention ${intervention}: ${response}`,
          );
          delivered = true;
        } catch {
          delivered = false;
        }
      }
      answered = true;
      return {
        type: "intervention.answered",
        data: { interventionId: intervention, answer: response, delivered },
      };
    });
    if (!answered) throw new Error(`Unknown intervention ${intervention}`);
    return (await this.inspect(id)).interventions.find(
      (item) => item.id === intervention,
    ) as ProjectIntervention;
  }

  publish(id: ProjectId, actor: ProjectActor): Promise<ProjectMap> {
    return this.mutate(id, actor, async (project) => {
      if (!this.tracker) throw new Error("Project tracker integration is unavailable");
      if (project.tracker) {
        await this.tracker.refresh(project);
        return { type: "project.fog.updated", data: { fog: project.fog } };
      }
      const publication = await this.tracker.publish(project);
      const events: readonly Omit<UnsequencedProjectEvent, "projectId" | "at" | "actor">[] = [
        { type: "project.tracker.linked", data: { tracker: publication.tracker } },
        ...project.decisions.flatMap((decision) => {
          const issue = publication.decisions.get(decision.id);
          return issue
            ? [{ type: "decision.issue.linked" as const, data: { decisionId: decision.id, issue } }]
            : [];
        }),
      ];
      return events;
    });
  }

  async exportSpec(id: ProjectId): Promise<string> {
    return renderProjectSpec(await this.inspect(id));
  }

  private newDecision(input: ProjectDecisionInput, createdAt: string): ProjectDecision {
    return {
      id: input.id ?? decisionId(this.ids.next("decision")),
      title: requireText("decision title", input.title),
      question: requireText("decision question", input.question),
      type: input.type,
      mode: input.mode,
      dependsOn: [...new Set(input.dependsOn ?? [])],
      state: "open",
      createdAt,
    };
  }

  private mutate(
    id: ProjectId,
    actor: ProjectActor,
    build:
      | ((project: ProjectMap) =>
          | Omit<UnsequencedProjectEvent, "projectId" | "at" | "actor">
          | readonly Omit<UnsequencedProjectEvent, "projectId" | "at" | "actor">[])
      | ((project: ProjectMap) => Promise<
          | Omit<UnsequencedProjectEvent, "projectId" | "at" | "actor">
          | readonly Omit<UnsequencedProjectEvent, "projectId" | "at" | "actor">[]
        >),
  ): Promise<ProjectMap> {
    return this.serial.run(id, async () => {
      const project = await this.inspect(id);
      const built = await build(project);
      const items = Array.isArray(built) ? built : [built];
      const at = this.clock.now();
      const events = items.map((event) => ({ projectId: id, at, actor, ...event }));
      await this.ledger.append(id, project.revision, events);
      return this.inspect(id);
    });
  }
}

export function frontierOf(project: ProjectMap): readonly ProjectDecision[] {
  const byId = new Map(project.decisions.map((decision) => [decision.id, decision] as const));
  return project.decisions.filter(
    (decision) =>
      decision.state === "open" &&
      decision.dependsOn.every((dependency) => byId.get(dependency)?.state === "resolved"),
  );
}

export function projectFromEvents(events: readonly ProjectEvent[]): ProjectMap {
  const created = events[0];
  if (!created || created.type !== "project.created") {
    throw new Error("Project ledger has no creation event");
  }
  const data = created.data as {
    readonly title: string;
    readonly destination: ProjectDestination;
    readonly notes: readonly string[];
    readonly fog: readonly string[];
    readonly decisions: readonly ProjectDecision[];
  };
  let project: ProjectMap = {
    id: created.projectId,
    revision: created.revision,
    title: data.title,
    destination: data.destination,
    notes: data.notes,
    fog: data.fog,
    decisions: data.decisions,
    interventions: [],
    createdAt: created.at,
    updatedAt: created.at,
  };
  for (const event of events.slice(1)) project = applyEvent(project, event);
  return project;
}

function applyEvent(project: ProjectMap, event: ProjectEvent): ProjectMap {
  const base = { ...project, revision: event.revision, updatedAt: event.at };
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "project.fog.updated":
      return { ...base, fog: data.fog as readonly string[] };
    case "project.tracker.linked":
      return { ...base, tracker: data.tracker as ProjectTrackerLink };
    case "decision.added":
      return { ...base, decisions: [...base.decisions, data.decision as ProjectDecision] };
    case "decision.claimed":
      return updateDecision(base, data.decisionId as DecisionId, (decision) => ({
        ...decision,
        state: "claimed",
        claim: { actor: event.actor, claimedAt: event.at },
      }));
    case "decision.released":
      return updateDecision(base, data.decisionId as DecisionId, (decision) => ({
        ...decision,
        state: "open",
        claim: undefined,
      }));
    case "decision.resolved":
      return updateDecision(base, data.decisionId as DecisionId, (decision) => ({
        ...decision,
        state: "resolved",
        resolution: data.resolution as ProjectDecisionResolution,
      }));
    case "decision.out_of_scope":
      return updateDecision(base, data.decisionId as DecisionId, (decision) => ({
        ...decision,
        state: "out_of_scope",
        outOfScopeReason: data.reason as string,
      }));
    case "decision.issue.linked":
      return updateDecision(base, data.decisionId as DecisionId, (decision) => ({
        ...decision,
        issue: data.issue as { readonly issueNumber: number; readonly url: string },
      }));
    case "intervention.requested": {
      const intervention = data.intervention as ProjectIntervention;
      return {
        ...updateDecision(base, intervention.decisionId, (decision) => ({
          ...decision,
          state: "awaiting_user",
        })),
        interventions: [...base.interventions, intervention],
      };
    }
    case "intervention.answered": {
      const interventionIdValue = data.interventionId as InterventionId;
      const pending = base.interventions.find((candidate) => candidate.id === interventionIdValue);
      if (!pending) throw new Error(`Unknown intervention ${interventionIdValue}`);
      const interventions = base.interventions.map((candidate) =>
        candidate.id === interventionIdValue
          ? {
              ...candidate,
              status: "answered" as const,
              answer: data.answer as string,
              answeredAt: event.at,
              answeredBy: event.actor,
              delivered: data.delivered as boolean,
            }
          : candidate,
      );
      return {
        ...updateDecision(base, pending.decisionId, (decision) => ({
          ...decision,
          state: "claimed",
        })),
        interventions,
      };
    }
    case "project.created":
      throw new Error("Project ledger contains more than one creation event");
  }
}

function applySynthetic(
  project: ProjectMap,
  event: Pick<ProjectEvent, "type" | "data">,
): ProjectMap {
  return applyEvent(project, {
    projectId: project.id,
    revision: project.revision + 1,
    type: event.type,
    data: event.data,
    at: project.updatedAt,
    actor: { rootRunId: "synthetic" as RunId, runId: "synthetic" as RunId },
  });
}

function updateDecision(
  project: ProjectMap,
  id: DecisionId,
  update: (decision: ProjectDecision) => ProjectDecision,
): ProjectMap {
  let found = false;
  const decisions = project.decisions.map((decision) => {
    if (decision.id !== id) return decision;
    found = true;
    return update(decision);
  });
  if (!found) throw new Error(`Unknown decision ${id}`);
  return { ...project, decisions };
}

function requireDecision(project: ProjectMap, id: DecisionId): ProjectDecision {
  const decision = project.decisions.find((candidate) => candidate.id === id);
  if (!decision) throw new Error(`Unknown decision ${id}`);
  return decision;
}

function assertClaimOwner(decision: ProjectDecision, actor: ProjectActor): void {
  if (!decision.claim || !sameActor(decision.claim.actor, actor)) {
    throw new Error(`Decision ${decision.id} must be claimed by ${actor.runId}`);
  }
}

function isRootActor(actor: ProjectActor): boolean {
  return actor.runId === actor.rootRunId;
}

function sameActor(left: ProjectActor, right: ProjectActor): boolean {
  return left.rootRunId === right.rootRunId && left.runId === right.runId;
}

function validateDestination(destination: ProjectDestination): void {
  requireText("destination outcome", destination.outcome);
  requireText("destination use case", destination.useCase);
  if (cleanList(destination.doneWhen).length === 0) {
    throw new Error("Destination must define at least one completion criterion");
  }
}

function validateDecisionGraph(decisions: readonly ProjectDecision[]): void {
  const byId = new Map(decisions.map((decision) => [decision.id, decision] as const));
  if (byId.size !== decisions.length) throw new Error("Decision IDs must be unique");
  for (const decision of decisions) {
    for (const dependency of decision.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`Decision ${decision.id} depends on unknown ${dependency}`);
      }
      if (dependency === decision.id) {
        throw new Error(`Decision ${decision.id} cannot depend on itself`);
      }
    }
  }
  const visiting = new Set<DecisionId>();
  const visited = new Set<DecisionId>();
  const visit = (id: DecisionId): void => {
    if (visiting.has(id)) throw new Error(`Decision dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const decision of decisions) visit(decision.id);
}

function cleanList(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requireText(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  if (normalized.length > 16_000) throw new Error(`${name} is too long`);
  return normalized;
}

function renderProjectSpec(project: ProjectMap): string {
  const resolved = project.decisions.filter((decision) => decision.state === "resolved");
  const outstanding = project.decisions.filter(
    (decision) => decision.state !== "resolved" && decision.state !== "out_of_scope",
  );
  const frontier = frontierOf(project);
  const outOfScope = project.decisions.filter((decision) => decision.state === "out_of_scope");
  const lines = [
    `# ${project.title}`,
    "",
    "## Destination",
    "",
    project.destination.outcome,
    "",
    `**Use case:** ${project.destination.useCase}`,
    "",
    "### Done when",
    "",
    ...project.destination.doneWhen.map((item) => `- ${item}`),
    "",
    "### Non-goals",
    "",
    ...(project.destination.nonGoals.length > 0
      ? project.destination.nonGoals.map((item) => `- ${item}`)
      : ["- None recorded."]),
    "",
    "## Decisions",
    "",
  ];
  for (const decision of resolved) {
    const resolution = decision.resolution as ProjectDecisionResolution;
    lines.push(
      `### ${decision.title}`,
      "",
      `**Question:** ${decision.question}`,
      "",
      resolution.summary,
      "",
      `**Rationale:** ${resolution.rationale}`,
      "",
      "**Evidence:**",
      ...((resolution.evidence.length > 0
        ? resolution.evidence
        : ["No external evidence recorded."]
      ).map((item) => `- ${item}`)),
      "",
      "**Consequences:**",
      ...((resolution.consequences.length > 0
        ? resolution.consequences
        : ["No explicit consequences recorded."]
      ).map((item) => `- ${item}`)),
      "",
      `*Provenance: run ${resolution.actor.runId}; resolved ${resolution.resolvedAt}.*`,
      "",
    );
  }
  lines.push("## Open frontier", "");
  lines.push(
    ...(frontier.length > 0
      ? frontier.map((decision) => `- ${decision.title} — ${decision.question}`)
      : outstanding.length > 0
        ? ["- No currently unblocked, unclaimed decisions."]
        : ["- No unresolved decisions."]),
    "",
    "## Not yet specified",
    "",
    ...(project.fog.length > 0 ? project.fog.map((item) => `- ${item}`) : ["- None."]),
    "",
    "## Out of scope",
    "",
    ...(outOfScope.length > 0
      ? outOfScope.map((decision) => `- ${decision.title} — ${decision.outOfScopeReason}`)
      : ["- None."]),
    "",
  );
  return lines.join("\n");
}
