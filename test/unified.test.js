"use strict";

/**
 * What the rendering owes on top of `git diff` parity (test/git-parity.test.js): review
 * annotations, which are not text changes and which git therefore cannot see at all.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { diffModel, renderUnifiedDiff } = require("../lib/unified");

const PROSE = [
  "# Monitor overfiring",
  "",
  "The monitor fires on 12% of benign traffic, well inside the review",
  "budget agreed with the deployment team.",
  "",
  "## Bycatch",
  "",
  "Of the cross-harm negatives, the monitor overfires at a rate we did",
  "not measure. Table 2 reports the calibrated operating points.",
  "",
  "## Limitations",
  "",
  "The corpus is a single month of traffic.",
  "",
];

function marked(replacements) {
  const lines = PROSE.slice();
  for (const [lineno, text] of Object.entries(replacements)) lines[lineno - 1] = text;
  return lines.join("\n");
}

function lines(source) {
  return renderUnifiedDiff(source, { path: "doc.md" }).split("\n");
}

test("a document with no markup renders as a summary and nothing else", () => {
  assert.equal(renderUnifiedDiff(PROSE.join("\n")), "# 0 suggestions, 0 comment threads\n");
});

test("the summary counts suggestions and threads separately", () => {
  const source = marked({
    3: "Fires on {~~12%~>11.4%~~}{>>recheck<<}{>>done<<} of {--benign--} traffic.",
  });
  assert.equal(lines(source)[0], "# 2 suggestions, 1 comment thread");
});

test("a remark in otherwise unchanged prose still gets a hunk to hang off", () => {
  const source = marked({ 13: "The corpus is a single month{>>say which month<<} of traffic." });
  const rendered = lines(source);
  assert.ok(
    rendered.some((line) => line.startsWith("@@ ")),
    "a hunk exists",
  );
  assert.ok(rendered.includes(" The corpus is a single month of traffic."), "context, not +/-");
  assert.ok(rendered.includes("# 💬 say which month"));
});

test("a thread renders its replies under the remark, in order", () => {
  const source = marked({ 13: "The corpus is{==a single month==}{>>which?<<}{>>August<<}." });
  const rendered = lines(source);
  const at = rendered.indexOf("# 💬 which?");
  assert.ok(at > 0);
  assert.equal(rendered[at + 1], "# ↳ August");
});

test("a highlight unwraps into the context line rather than showing as a change", () => {
  const source = marked({ 13: "The corpus is {==a single month==}{>>widen it<<} of traffic." });
  const rendered = lines(source);
  assert.ok(rendered.includes(" The corpus is a single month of traffic."));
  assert.ok(!rendered.some((line) => line.startsWith("-") && !line.startsWith("---")));
});

test("a note on a changed line hangs off the change, after the new text", () => {
  const source = marked({
    13: "The corpus is {~~a single month~>a year~~}{>>agreed<<} of traffic.",
  });
  const rendered = lines(source);
  const plus = rendered.findIndex((line) => line.startsWith("+The corpus"));
  assert.ok(plus > 0);
  assert.equal(rendered[plus + 1], "# 💬 agreed");
});

test("a multi-line remark keeps its body under the marker", () => {
  const source = marked({ 13: "The corpus{>>two lines\nof remark<<} is a single month." });
  const rendered = lines(source);
  const at = rendered.indexOf("# 💬 two lines");
  assert.ok(at > 0);
  assert.equal(rendered[at + 1], "#   of remark");
});

test("markers inside a fenced block never reach the diff", () => {
  const source = ["# Syntax", "", "```md", "A {++suggestion++} looks like this.", "```", ""].join(
    "\n",
  );
  assert.equal(renderUnifiedDiff(source), "# 0 suggestions, 0 comment threads\n");
});

test("a nested marker is reported rather than quietly half-resolved", () => {
  const source = marked({ 13: "The corpus is {++a year {>>why<<} of traffic++}." });
  assert.ok(lines(source)[1].startsWith("# ! nested marker at offset "));
});

test("two suggestions that cancel out leave no hunk", () => {
  const source = marked({ 13: "The corpus is {--a single month--}{++a single month++}." });
  const model = diffModel(source);
  assert.equal(model.changes, 2);
  assert.deepEqual(model.hunks, []);
  assert.equal(model.oldText, model.newText);
});

test("the diff carries the two readings, so nothing has to resolve the file twice", () => {
  const model = diffModel(marked({ 13: "A corpus of {~~one month~>one year~~}." }));
  assert.ok(model.oldText.includes("A corpus of one month."));
  assert.ok(model.newText.includes("A corpus of one year."));
});
