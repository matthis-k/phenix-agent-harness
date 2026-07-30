import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { withWorkspaceInputSubmission } from "../extension/workspace/workspace-input-api.ts";

test("submits slash commands through Pi's native input pipeline", async () => {
  const submitted: string[] = [];
  const sent: unknown[] = [];
  const pi = {
    submitUserInput(text: string): Promise<void> {
      submitted.push(text);
      return Promise.resolve();
    },
    sendUserMessage(content: unknown): void {
      sent.push(content);
    },
  } as unknown as ExtensionAPI;

  const workspacePi = withWorkspaceInputSubmission(pi);
  await Promise.resolve(workspacePi.sendUserMessage("/login openai"));

  assert.deepEqual(submitted, ["/login openai"]);
  assert.deepEqual(sent, []);
});

test("keeps ordinary workspace messages on the extension message path", () => {
  const submitted: string[] = [];
  const sent: unknown[] = [];
  const pi = {
    submitUserInput(text: string): Promise<void> {
      submitted.push(text);
      return Promise.resolve();
    },
    sendUserMessage(content: unknown): void {
      sent.push(content);
    },
  } as unknown as ExtensionAPI;

  const workspacePi = withWorkspaceInputSubmission(pi);
  workspacePi.sendUserMessage("Explain this code");

  assert.deepEqual(submitted, []);
  assert.deepEqual(sent, ["Explain this code"]);
});
