import assert from "node:assert/strict";
import test from "node:test";

import { JsonlDecodeError, JsonlDecoder, serializeJsonLine } from "../headless/jsonl.ts";

test("JSONL decoder preserves UTF-8 characters split across chunks", () => {
  const decoder = new JsonlDecoder();
  const encoded = Buffer.from(`${JSON.stringify({ message: "größer" })}\n`, "utf8");
  const split = encoded.indexOf(Buffer.from("ö")) + 1;

  assert.deepEqual(decoder.push(encoded.subarray(0, split)), []);
  assert.deepEqual(decoder.push(encoded.subarray(split)), [{ message: "größer" }]);
  assert.deepEqual(decoder.finish(), []);
});

test("only LF delimits records and CRLF input is accepted", () => {
  const decoder = new JsonlDecoder();
  const separator = "\u2028";
  const input = `${JSON.stringify({ message: `left${separator}right` })}\r\n`;

  assert.deepEqual(decoder.push(input), [{ message: `left${separator}right` }]);
});

test("blank lines are ignored without weakening JSON validation", () => {
  const decoder = new JsonlDecoder();
  assert.deepEqual(decoder.push(`\n\r\n${JSON.stringify({ ok: true })}\n`), [{ ok: true }]);
  assert.throws(() => decoder.push(`not-json\n`), JsonlDecodeError);
});

test("frames are bounded before a delimiter arrives", () => {
  const decoder = new JsonlDecoder(8);
  assert.throws(() => decoder.push(`{"message":"too large"}`), /exceeds 8 bytes/);
});

test("serializer emits exactly one LF-delimited JSON record", () => {
  assert.equal(serializeJsonLine({ text: "a\nb" }), `{"text":"a\\nb"}\n`);
  assert.throws(() => serializeJsonLine(undefined), JsonlDecodeError);
});
