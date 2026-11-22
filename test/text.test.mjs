// text.test.mjs — the width-aware string helpers every label goes through.
import test from "node:test";
import assert from "node:assert/strict";
import { displayWidth, scrub, stripLeadingGlyphs, stripTrailingGlyph, truncate } from "../src/text.mjs";

test("text: scrub strips control characters and collapses space runs", () => {
  assert.equal(scrub("  a\u0007\u001b  b  "), "a b");
  assert.equal(scrub("one\ttwo\nthree"), "one two three");
  assert.equal(scrub(null), "");
});

test("text: displayWidth counts a CJK glyph as two cells", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("\u6807\u7b7e"), 4);
  assert.equal(displayWidth("a\u6807"), 3);
});

test("text: truncate never exceeds the budget and marks the cut", () => {
  assert.equal(truncate("short", 10), "short");
  const cut = truncate("\u8fd9\u662f\u4e00\u4e2a\u5f88\u957f\u7684\u6807\u9898", 8);
  assert.ok(displayWidth(cut) <= 8);
  assert.ok(cut.endsWith("\u2026"));
});

test("text: stripLeadingGlyphs drops a leading symbol but keeps letters", () => {
  assert.equal(stripLeadingGlyphs("\u2733 Task"), "Task");
  assert.equal(stripLeadingGlyphs("\u2022 item"), "item");
  assert.equal(stripLeadingGlyphs("\u03c0 - workflow"), "\u03c0 - workflow"); // the mark is a letter; taskFromTitle peels it
  assert.equal(stripLeadingGlyphs("plain"), "plain");
});

test("text: stripTrailingGlyph drops a detached status glyph", () => {
  assert.equal(stripTrailingGlyph("Task \u273b"), "Task");
  assert.equal(stripTrailingGlyph("Task 2"), "Task 2");
});

test("text: bidi overrides are stripped so a label cannot spoof its direction", () => {
  assert.equal(scrub("a\u202eb"), "a b");
  assert.equal(scrub("a\u2066b\u2069"), "a b");
});
