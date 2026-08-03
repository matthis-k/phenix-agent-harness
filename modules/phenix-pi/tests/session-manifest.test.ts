import assert from "node:assert/strict";
import test from "node:test";

import {
  isSessionManifestCommand,
  parseSessionManifestCommand,
} from "../extension/workspace/session-manifest.ts";

test("parses the session copy command with an optional output path", () => {
  assert.deepEqual(parseSessionManifestCommand("/session copy"), {});
  assert.deepEqual(parseSessionManifestCommand("/session copy --file debug/session.json"), {
    file: "debug/session.json",
  });
  assert.deepEqual(parseSessionManifestCommand('/session copy --file "debug session.json"'), {
    file: "debug session.json",
  });
});

test("does not intercept ordinary session information commands", () => {
  assert.equal(isSessionManifestCommand("/session"), false);
  assert.equal(isSessionManifestCommand("/session details"), false);
  assert.equal(isSessionManifestCommand("/copy"), false);
});
