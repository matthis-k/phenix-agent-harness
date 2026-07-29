import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { TerminalView } from "../extension/components/terminal-view.ts";


test("follows appended output until the user scrolls away", () => {
  const view = new TerminalView();
  view.setLines(["zero", "one", "two", "three", "four"]);

  assert.equal(view.render(12, 2).offset, 3);
  view.dispatch({ kind: "scroll", lines: -1 }, 2);
  assert.equal(view.render(12, 2).offset, 2);
  assert.equal(view.render(12, 2).followEnd, false);

  view.appendLines(["five"]);
  assert.equal(view.render(12, 2).offset, 2);
  view.dispatch({ kind: "end" }, 2);
  assert.equal(view.render(12, 2).offset, 4);

  view.appendLines(["six"]);
  const frame = view.render(12, 2);
  assert.equal(frame.offset, 5);
  assert.match(frame.lines[1] ?? "", /six/);
});

test("bounds scrollback and reconciles a fixed viewport after trimming", () => {
  const view = new TerminalView({ maxLines: 3 });
  view.setLines(["zero", "one", "two"]);
  view.dispatch({ kind: "home" }, 1);
  view.appendLines(["three", "four"]);

  assert.deepEqual(view.lines, ["two", "three", "four"]);
  const frame = view.render(10, 1);
  assert.equal(frame.offset, 0);
  assert.match(frame.lines[0] ?? "", /two/);
});

test("clips ANSI output by visible columns and supports horizontal scrolling", () => {
  const view = new TerminalView();
  view.setLines(["\x1b[31mabcdef\x1b[0m"]);
  view.dispatch({ kind: "horizontal", columns: 2 }, 1);

  const frame = view.render(3, 1);
  assert.equal(frame.horizontalOffset, 2);
  assert.equal(visibleWidth(frame.lines[0] ?? ""), 3);
  assert.match(frame.lines[0] ?? "", /cde/);
});

test("normalizes appended terminal text into lines", () => {
  const view = new TerminalView();
  view.append("one\r\ntwo\n");
  assert.deepEqual(view.lines, ["one", "two"]);
});
