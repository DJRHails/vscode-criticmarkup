"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  acceptAll,
  hasMarkup,
  isChange,
  nestedSpans,
  rejectAll,
  scan,
  threads,
} = require("../lib/criticmarkup");

test("each marker kind scans with its accepted and rejected readings", () => {
  const spans = scan("{++in++} {--out--} {~~old~>new~~} {>>note<<} {==anchor==}");
  assert.deepEqual(
    spans.map((span) => [span.kind, span.accepted, span.rejected]),
    [
      ["insertion", "in", ""],
      ["deletion", "", "out"],
      ["substitution", "new", "old"],
      ["comment", "", ""],
      ["highlight", "anchor", "anchor"],
    ],
  );
});

test("adjacent markers stay separate rather than merging into one", () => {
  const spans = scan("{--a--}{++b++}");
  assert.deepEqual(
    spans.map((span) => span.source),
    ["{--a--}", "{++b++}"],
  );
});

test("a body may run across lines", () => {
  assert.equal(scan("{++two\nlines++}")[0].text, "two\nlines");
});

test("an unterminated marker is not a span, but it is still markup", () => {
  assert.deepEqual(scan("an unclosed {++marker"), []);
  assert.ok(hasMarkup("an unclosed {++marker"));
});

test("markers inside a fenced block are quoted samples, not suggestions", () => {
  const source = ["prose {++real++}", "", "```md", "sample {++quoted++}", "```", "", "tail"].join(
    "\n",
  );
  assert.deepEqual(
    scan(source).map((span) => span.text),
    ["real"],
  );
  assert.ok(acceptAll(source).includes("{++quoted++}"));
});

test("a tilde fence closes with tildes, so backticks inside it stay quoted", () => {
  const source = ["~~~", "{--hidden--}", "~~~", "{--shown--}"].join("\n");
  assert.deepEqual(
    scan(source).map((span) => span.text),
    ["shown"],
  );
});

test("accepting and rejecting are the two readings of the same document", () => {
  const source = "The rate is {~~12%~>11.4%~~}{>>recompute<<}, a {--large--}{++small++} share.";
  assert.equal(rejectAll(source), "The rate is 12%, a large share.");
  assert.equal(acceptAll(source), "The rate is 11.4%, a small share.");
});

test("rejecting every suggestion round-trips an annotated document", () => {
  const plain = "One sentence. Another sentence.\n";
  const annotated = "One {~~sentence~>clause~~}{>>tighter<<}. Another sentence.\n";
  assert.equal(rejectAll(annotated), plain);
});

test("only insertions, deletions and substitutions change the text", () => {
  const kinds = scan("{++a++}{--b--}{~~c~>d~~}{>>e<<}{==f==}");
  assert.deepEqual(
    kinds.map((span) => [span.kind, isChange(span)]),
    [
      ["insertion", true],
      ["deletion", true],
      ["substitution", true],
      ["comment", false],
      ["highlight", false],
    ],
  );
});

test("a highlight, its remark and the replies chain into one thread", () => {
  const found = threads(scan("{==passage==}{>>tighten<<}{>>agreed<<} and {>>standalone<<}"));
  assert.equal(found.length, 2);
  assert.equal(found[0].anchor.text, "passage");
  assert.deepEqual(
    found[0].comments.map((span) => span.text),
    ["tighten", "agreed"],
  );
  assert.equal(found[1].anchor, null);
  assert.equal(found[1].comments.length, 1);
});

test("a gap between two remarks makes them two threads", () => {
  assert.equal(threads(scan("{>>one<<} gap {>>two<<}")).length, 2);
});

test("a highlight that does not touch its remark is not its anchor", () => {
  const found = threads(scan("{==passage==} {>>remark<<}"));
  assert.equal(found[0].anchor, null);
});

test("a marker whose body opens another marker is reported as nested", () => {
  assert.deepEqual(
    nestedSpans("{++new {>>why<<} text++}").map((span) => span.kind),
    ["insertion"],
  );
  assert.deepEqual(nestedSpans("{++plain++}{>>beside<<}"), []);
});
