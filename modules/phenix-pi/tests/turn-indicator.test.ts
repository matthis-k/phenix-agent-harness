import assert from "node:assert/strict";
import test from "node:test";

import { renderWorkspaceTurn } from "../extension/workspace/turn-indicator.ts";

test("turn indicator distinguishes user, root, descendants, and concurrent work", () => {
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
    "TURN · AGENTS · 2 active · input steers",
  );
  assert.equal(
    renderWorkspaceTurn(undefined, { rootActive: true, activeDescendants: 3 }),
    "TURN · PHENIX + AGENTS · 3 active · input steers",
  );
});
