import assert from "node:assert/strict";
import test from "node:test";

import { architectDefinition, scoutDefinition } from "../definitions/agents.ts";

test("QA analysis agents do not delegate command execution to scouts", () => {
  assert.match(scoutDefinition.prompt.render(), /no command-execution capability/i);
  assert.match(scoutDefinition.prompt.render(), /phenix_fail immediately/i);
  assert.match(architectDefinition.prompt.render(), /deterministic checks are handled by a separate tester branch/i);
  assert.match(architectDefinition.prompt.render(), /Delegate to agent\.scout only for a focused repository evidence question/i);
});
