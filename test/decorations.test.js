"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { decorationRegions } = require("../lib/decorations");

/** The slices of `source` a decoration kind covers, so a region is readable as its text. */
function texts(source, kind) {
  return decorationRegions(source)[kind].map((at) => source.slice(at.start, at.end));
}

test("a substitution paints its two sides differently and dims the arrow", () => {
  const source = "Fires on {~~12%~>11.4%~~}.";
  assert.deepEqual(texts(source, "deleted"), ["12%"]);
  assert.deepEqual(texts(source, "inserted"), ["11.4%"]);
  assert.deepEqual(texts(source, "delimiters"), ["{~~", "~~}", "~>"]);
});

test("each other kind paints its body and dims its braces", () => {
  assert.deepEqual(texts("{++new++}", "inserted"), ["new"]);
  assert.deepEqual(texts("{--old--}", "deleted"), ["old"]);
  assert.deepEqual(texts("{==here==}", "highlighted"), ["here"]);
  assert.deepEqual(texts("{>>note<<}", "notes"), ["note"]);
  assert.deepEqual(texts("{++new++}", "delimiters"), ["{++", "++}"]);
});

test("a reply is dimmed like a note but told apart from the remark it answers", () => {
  const source = "{==p==}{>>first<<}{>>second<<}";
  assert.deepEqual(texts(source, "notes"), ["first"]);
  assert.deepEqual(texts(source, "replies"), ["second"]);
});

test("markers inside a code fence are not decorated", () => {
  const source = ["```md", "{++sample++}", "```", "{++real++}"].join("\n");
  assert.deepEqual(texts(source, "inserted"), ["real"]);
});

test("a document with no markup has nothing to paint", () => {
  const regions = decorationRegions("plain prose\n");
  assert.deepEqual(Object.values(regions).flat(), []);
});
