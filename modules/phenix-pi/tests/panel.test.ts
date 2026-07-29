import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { renderPanel } from "../extension/components/panel.ts";

const BACKGROUND = "\x1b[48;5;17m";
const RESET = "\x1b[49m";

test("owns every rendered row and constrains content to its inner rectangle", () => {
  const frame = renderPanel({
    lines: ["first line", "second line", "ignored"],
    width: 12,
    height: 5,
    title: "panel",
    focused: true,
    paddingX: 1,
    paddingY: 1,
    style: {
      surface: (line) => `${BACKGROUND}${line}${RESET}`,
      title: (title, context) => `${context.focused ? ">" : " "}${title.toUpperCase()}`,
    },
  });

  assert.equal(frame.contentWidth, 10);
  assert.equal(frame.contentHeight, 2);
  assert.equal(frame.lines.length, 5);
  assert.ok(frame.lines.every((line) => line.startsWith(BACKGROUND) && line.endsWith(RESET)));
  assert.ok(frame.lines.every((line) => visibleWidth(line) === 12));
  assert.match(frame.lines[1] ?? "", />PANEL/);
  assert.match(frame.lines[2] ?? "", /first line/);
  assert.match(frame.lines[3] ?? "", /second lin/);
  assert.doesNotMatch(frame.lines.join("\n"), /ignored/);
});

test("renders a background-owned empty panel", () => {
  const frame = renderPanel({
    lines: [],
    width: 4,
    height: 2,
    style: { surface: (line) => `${BACKGROUND}${line}${RESET}` },
  });

  assert.deepEqual(frame.lines, [`${BACKGROUND}    ${RESET}`, `${BACKGROUND}    ${RESET}`]);
});
