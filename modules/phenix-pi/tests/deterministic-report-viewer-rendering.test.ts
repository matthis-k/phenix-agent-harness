import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../extension/deterministic-report-viewer.ts", import.meta.url),
  "utf8",
);

test("deterministic report entries use Pi's native Markdown component", () => {
  assert.match(source, /import \{ Markdown \} from "@earendil-works\/pi-tui"/);
  assert.match(source, /new Markdown\(entry\.data\?\.markdown \?\? "", 1, 0, getMarkdownTheme\(\)\)/);
});
