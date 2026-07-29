import assert from "node:assert/strict";
import test from "node:test";

import { renderWorkspaceTurn } from "../extension/workspace/turn-indicator.ts";

test("turn indicator distinguishes user, foreground work, and background agents", () => {
  assert.equal(
    renderWorkspaceTurn(undefined, { rootActive: false, activeDescendants: 0 }),
    "TURN · YOU",
  );
  assert.equal(
    renderWorkspaceTurn(undefined, { rootActive: true, activeDescendants: 0 }),
    "TURN · PHENIX · input steers",
  );
  assert.equal(
    renderWorkspaceTurn(undefined, { rootActive: false, activeDescendants: 2 }),
    "TURN · YOU · 2 agents background",
  );
  assert.equal(
    renderWorkspaceTurn(undefined, { rootActive: true, activeDescendants: 3 }),
    "TURN · PHENIX + AGENTS · 3 active · input steers",
  );
});
