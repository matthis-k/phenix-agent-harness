import { spawn } from "node:child_process";

import type {
  ProjectDecision,
  ProjectMap,
  ProjectTrackerLink,
} from "../../domain/project/model.ts";
import type {
  ProjectTracker,
  ProjectTrackerPublication,
} from "../../ports/project-tracker.ts";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], cwd: string, stdin?: string): Promise<CommandResult>;
}

export class GhProjectTracker implements ProjectTracker {
  private readonly cwd: string;
  private readonly commands: CommandRunner;

  constructor(cwd: string, commands: CommandRunner = new SpawnCommandRunner()) {
    this.cwd = cwd;
    this.commands = commands;
  }

  async publish(project: ProjectMap): Promise<ProjectTrackerPublication> {
    const repository = await this.repository();
    await this.ensureLabels(repository.nameWithOwner);
    const mapUrl = await this.createIssue(repository.nameWithOwner, {
      title: `Project map: ${project.title}`,
      body: renderMapBody(project),
      labels: ["phenix:project-map"],
    });
    const mapIssueNumber = issueNumber(mapUrl);
    const issueByDecision = new Map<string, { readonly issueNumber: number; readonly url: string }>();

    for (const decision of project.decisions) {
      const url = await this.createIssue(repository.nameWithOwner, {
        title: decision.title,
        body: renderDecisionBody(project, decision),
        labels: ["phenix:decision", `phenix:${decision.type}`, `phenix:${decision.mode}`],
        parent: mapIssueNumber,
      });
      issueByDecision.set(decision.id, { issueNumber: issueNumber(url), url });
    }

    for (const decision of project.decisions) {
      const issue = issueByDecision.get(decision.id);
      const blockers = decision.dependsOn
        .map((dependency) => issueByDecision.get(dependency)?.issueNumber)
        .filter((number): number is number => number !== undefined);
      if (!issue || blockers.length === 0) continue;
      await this.commands.run(
        "gh",
        [
          "issue",
          "edit",
          String(issue.issueNumber),
          "--repo",
          repository.nameWithOwner,
          "--add-blocked-by",
          blockers.join(","),
        ],
        this.cwd,
      );
    }

    return {
      tracker: {
        repository: repository.nameWithOwner,
        mapIssueNumber,
        url: mapUrl,
      },
      decisions: issueByDecision,
    };
  }

  async claim(project: ProjectMap, decision: ProjectDecision): Promise<void> {
    const link = requireIssue(project, decision);
    await this.commands.run(
      "gh",
      [
        "issue",
        "edit",
        String(link.issueNumber),
        "--repo",
        requireTracker(project).repository,
        "--add-assignee",
        "@me",
      ],
      this.cwd,
    );
  }

  async release(project: ProjectMap, decision: ProjectDecision): Promise<void> {
    const link = requireIssue(project, decision);
    await this.commands.run(
      "gh",
      [
        "issue",
        "edit",
        String(link.issueNumber),
        "--repo",
        requireTracker(project).repository,
        "--remove-assignee",
        "@me",
      ],
      this.cwd,
    );
  }

  async resolve(project: ProjectMap, decision: ProjectDecision): Promise<void> {
    const link = requireIssue(project, decision);
    const tracker = requireTracker(project);
    const comment =
      decision.state === "out_of_scope"
        ? `## Out of scope\n\n${decision.outOfScopeReason ?? "Outside the project destination."}`
        : renderResolution(decision);
    await this.commands.run(
      "gh",
      [
        "issue",
        "close",
        String(link.issueNumber),
        "--repo",
        tracker.repository,
        "--comment",
        comment,
        "--reason",
        decision.state === "out_of_scope" ? "not planned" : "completed",
      ],
      this.cwd,
    );
  }

  async refresh(project: ProjectMap): Promise<void> {
    const tracker = requireTracker(project);
    await this.commands.run(
      "gh",
      [
        "issue",
        "edit",
        String(tracker.mapIssueNumber),
        "--repo",
        tracker.repository,
        "--body-file",
        "-",
      ],
      this.cwd,
      renderMapBody(project),
    );
  }

  private async repository(): Promise<{ readonly nameWithOwner: string; readonly url: string }> {
    const result = await this.commands.run(
      "gh",
      ["repo", "view", "--json", "nameWithOwner,url"],
      this.cwd,
    );
    const parsed = JSON.parse(result.stdout) as { readonly nameWithOwner?: string; readonly url?: string };
    if (!parsed.nameWithOwner || !parsed.url) throw new Error("Unable to identify GitHub repository");
    return { nameWithOwner: parsed.nameWithOwner, url: parsed.url };
  }

  private async ensureLabels(repository: string): Promise<void> {
    const labels = [
      ["phenix:project-map", "Cross-session Phenix project map", "6c7086"],
      ["phenix:decision", "Decision node in a Phenix project map", "89b4fa"],
      ["phenix:research", "Agent-driven evidence gathering", "94e2d5"],
      ["phenix:prototype", "Human-reviewed low-fidelity prototype", "f9e2af"],
      ["phenix:grilling", "Human-in-the-loop decision conversation", "cba6f7"],
      ["phenix:task", "Prerequisite task that unlocks a decision", "fab387"],
      ["phenix:afk", "May be resolved without live user input", "a6e3a1"],
      ["phenix:hitl", "Requires live human input", "f38ba8"],
    ] as const;
    for (const [name, description, color] of labels) {
      await this.commands.run(
        "gh",
        [
          "label",
          "create",
          name,
          "--repo",
          repository,
          "--description",
          description,
          "--color",
          color,
          "--force",
        ],
        this.cwd,
      );
    }
  }

  private async createIssue(
    repository: string,
    input: {
      readonly title: string;
      readonly body: string;
      readonly labels: readonly string[];
      readonly parent?: number;
    },
  ): Promise<string> {
    const args = [
      "issue",
      "create",
      "--repo",
      repository,
      "--title",
      input.title,
      "--body-file",
      "-",
    ];
    for (const label of input.labels) args.push("--label", label);
    if (input.parent !== undefined) args.push("--parent", String(input.parent));
    const result = await this.commands.run("gh", args, this.cwd, input.body);
    const url = result.stdout.trim().split("\n").at(-1)?.trim();
    if (!url || !/^https:\/\/github\.com\/.+\/issues\/\d+$/.test(url)) {
      throw new Error(`GitHub did not return a valid issue URL: ${result.stdout.trim()}`);
    }
    return url;
  }
}

class SpawnCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[], cwd: string, stdin?: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(`Command ${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
      });
      child.stdin.end(stdin ?? "");
    });
  }
}

function renderMapBody(project: ProjectMap): string {
  const decisions = project.decisions.filter((decision) => decision.state === "resolved");
  const outOfScope = project.decisions.filter((decision) => decision.state === "out_of_scope");
  return [
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
    "## Notes",
    "",
    ...(project.notes.length > 0 ? project.notes.map((item) => `- ${item}`) : ["- None."]),
    "",
    "## Decisions so far",
    "",
    ...(decisions.length > 0
      ? decisions.map((decision) => {
          const title = decision.issue
            ? `[${decision.title}](${decision.issue.url})`
            : decision.title;
          return `- ${title} — ${decision.resolution?.summary ?? "Resolved"}`;
        })
      : ["- None yet."]),
    "",
    "## Not yet specified",
    "",
    ...(project.fog.length > 0 ? project.fog.map((item) => `- ${item}`) : ["- None."]),
    "",
    "## Out of scope",
    "",
    ...(outOfScope.length > 0
      ? outOfScope.map((decision) => {
          const title = decision.issue
            ? `[${decision.title}](${decision.issue.url})`
            : decision.title;
          return `- ${title} — ${decision.outOfScopeReason ?? "Outside the destination"}`;
        })
      : ["- None."]),
    "",
    `<!-- phenix-project-id: ${project.id} -->`,
  ].join("\n");
}

function renderDecisionBody(project: ProjectMap, decision: ProjectDecision): string {
  const dependencies = decision.dependsOn
    .map((id) => project.decisions.find((candidate) => candidate.id === id)?.title)
    .filter((title): title is string => title !== undefined);
  return [
    "## Question",
    "",
    decision.question,
    "",
    "## Working mode",
    "",
    `- Type: ${decision.type}`,
    `- Interaction: ${decision.mode}`,
    ...(dependencies.length > 0 ? [`- Depends on: ${dependencies.join(", ")}`] : []),
    "",
    "## Resolution protocol",
    "",
    "Record one canonical resolution comment containing the answer, rationale, evidence, consequences, and Phenix run provenance. Do not place the answer in this body.",
    "",
    `<!-- phenix-project-id: ${project.id}; phenix-decision-id: ${decision.id} -->`,
  ].join("\n");
}

function renderResolution(decision: ProjectDecision): string {
  const resolution = decision.resolution;
  if (!resolution) throw new Error(`Decision ${decision.id} has no resolution`);
  return [
    "## Resolution",
    "",
    resolution.summary,
    "",
    "### Rationale",
    "",
    resolution.rationale,
    "",
    "### Evidence",
    "",
    ...(resolution.evidence.length > 0
      ? resolution.evidence.map((item) => `- ${item}`)
      : ["- No external evidence recorded."]),
    "",
    "### Consequences",
    "",
    ...(resolution.consequences.length > 0
      ? resolution.consequences.map((item) => `- ${item}`)
      : ["- No explicit consequences recorded."]),
    "",
    `Resolved by Phenix run \`${resolution.actor.runId}\` at ${resolution.resolvedAt}.`,
  ].join("\n");
}

function requireTracker(project: ProjectMap): ProjectTrackerLink {
  if (!project.tracker) throw new Error(`Project ${project.id} is not published to GitHub`);
  return project.tracker;
}

function requireIssue(
  project: ProjectMap,
  decision: ProjectDecision,
): { readonly issueNumber: number; readonly url: string } {
  requireTracker(project);
  if (!decision.issue) throw new Error(`Decision ${decision.id} has no GitHub issue`);
  return decision.issue;
}

function issueNumber(url: string): number {
  const match = url.match(/\/issues\/(\d+)$/);
  if (!match) throw new Error(`Invalid GitHub issue URL ${url}`);
  return Number(match[1]);
}
