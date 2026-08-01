import assert from "node:assert/strict";
import test from "node:test";

import { type CommandRunner, GhProjectTracker } from "../adapters/github/gh-project-tracker.ts";
import { decisionId, type ProjectMap, projectId } from "../domain/project/model.ts";

class FakeCommands implements CommandRunner {
  readonly calls: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly stdin?: string;
  }> = [];
  private nextIssue = 1;

  async run(command: string, args: readonly string[], _cwd: string, stdin?: string) {
    this.calls.push({ command, args, ...(stdin === undefined ? {} : { stdin }) });
    if (args[0] === "repo" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          nameWithOwner: "owner/repository",
          url: "https://github.com/owner/repository",
        }),
        stderr: "",
      };
    }
    if (args[0] === "issue" && args[1] === "create") {
      const number = this.nextIssue;
      this.nextIssue += 1;
      return { stdout: `https://github.com/owner/repository/issues/${number}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

test("publishing creates a map, sub-issues, then native dependency edges", async () => {
  const commands = new FakeCommands();
  const tracker = new GhProjectTracker(process.cwd(), commands);
  const first = decisionId("decision-first");
  const second = decisionId("decision-second");
  const project: ProjectMap = {
    id: projectId("project-test"),
    revision: 1,
    title: "Large project",
    destination: {
      outcome: "A complete specification",
      useCase: "Coordinate independent implementation sessions",
      doneWhen: ["Every design decision is resolved"],
      nonGoals: [],
    },
    notes: [],
    fog: ["Later deployment decisions"],
    decisions: [
      {
        id: first,
        title: "Choose persistence",
        question: "What is canonical?",
        type: "research",
        mode: "afk",
        dependsOn: [],
        state: "open",
        createdAt: "2026-07-30T12:00:00.000Z",
      },
      {
        id: second,
        title: "Choose synchronization",
        question: "How is GitHub projected?",
        type: "grilling",
        mode: "hitl",
        dependsOn: [first],
        state: "open",
        createdAt: "2026-07-30T12:00:00.000Z",
      },
    ],
    interventions: [],
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
  };

  const publication = await tracker.publish(project);
  assert.equal(publication.tracker.mapIssueNumber, 1);
  assert.equal(publication.decisions.get(second)?.issueNumber, 3);

  const childCreates = commands.calls.filter(
    (call) =>
      call.args[0] === "issue" && call.args[1] === "create" && call.args.includes("--parent"),
  );
  assert.equal(childCreates.length, 2);
  assert.ok(childCreates.every((call) => call.args.includes("1")));

  const dependency = commands.calls.find((call) => call.args.includes("--add-blocked-by"));
  assert.deepEqual(dependency?.args, [
    "issue",
    "edit",
    "3",
    "--repo",
    "owner/repository",
    "--add-blocked-by",
    "2",
  ]);
});
