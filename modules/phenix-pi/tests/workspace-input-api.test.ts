import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isWorkspaceCommandInput,
  withWorkspaceInputSubmission,
  workspaceCommandName,
} from "../extension/workspace/workspace-input-api.ts";

function testPi() {
  const submitted: string[] = [];
  const sent: unknown[] = [];
  const pi = {
    getCommands() {
      return [{ name: "login", description: "Authenticate" }];
    },
    submitUserInput(text: string): Promise<void> {
      submitted.push(text);
      return Promise.resolve();
    },
    sendUserMessage(content: unknown): void {
      sent.push(content);
    },
  } as unknown as ExtensionAPI;
  return { pi, submitted, sent };
}

test("submits registered slash commands through Pi's native input pipeline", async () => {
  const { pi, submitted, sent } = testPi();

  const workspacePi = withWorkspaceInputSubmission(pi);
  await Promise.resolve(workspacePi.sendUserMessage("/login openai"));

  assert.deepEqual(submitted, ["/login openai"]);
  assert.deepEqual(sent, []);
});

test("keeps unknown slash-prefixed input on the message path", () => {
  const { pi, submitted, sent } = testPi();

  const workspacePi = withWorkspaceInputSubmission(pi);
  workspacePi.sendUserMessage("/explain why this failed");

  assert.deepEqual(submitted, []);
  assert.deepEqual(sent, ["/explain why this failed"]);
});

test("keeps ordinary workspace messages on the extension message path", () => {
  const { pi, submitted, sent } = testPi();

  const workspacePi = withWorkspaceInputSubmission(pi);
  workspacePi.sendUserMessage("Explain this code");

  assert.deepEqual(submitted, []);
  assert.deepEqual(sent, ["Explain this code"]);
});

test("matches the exact command token rather than any slash prefix", () => {
  const commands = [{ name: "login" }];

  assert.equal(workspaceCommandName("  /login openai  "), "login");
  assert.equal(isWorkspaceCommandInput("/login openai", commands), true);
  assert.equal(isWorkspaceCommandInput("/login-extra openai", commands), false);
  assert.equal(isWorkspaceCommandInput("/unknown", commands), false);
  assert.equal(isWorkspaceCommandInput("plain input", commands), false);
});
