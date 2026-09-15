"use strict";

/**
 * The claim this extension makes is that it renders CriticMarkup *the way git renders a diff*.
 * That is checkable rather than assertable: resolve the document both ways, hand the two
 * versions to real `git diff -U3`, and require our hunks to come back identical — same `@@`
 * arithmetic, same grouping, same context, same heading trailer. And what `git diff` writes,
 * `git apply` must take: the rendering with its review notes stripped has to be a patch that
 * turns the rejected reading into the accepted one.
 *
 * Fixtures here carry no comment threads. An annotation is not a text change, so it appears in
 * our rendering and cannot appear in git's; parity is only meaningful over the edits themselves
 * (test/unified.test.js covers what annotations add on top).
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");

const { diffModel, renderUnifiedDiff } = require("../lib/unified");

/** A git repo holding both readings, so `git diff` and `git apply` see the real files. */
function fixture(source) {
  const { oldText, newText } = diffModel(source);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "criticmarkup-"));
  execFileSync("git", ["init", "-q", dir]);
  // The heading in a hunk header comes from git's markdown diff driver, which is attribute-driven.
  fs.writeFileSync(path.join(dir, ".gitattributes"), "*.md diff=markdown\n");
  fs.mkdirSync(path.join(dir, "a"));
  fs.mkdirSync(path.join(dir, "b"));
  fs.writeFileSync(path.join(dir, "a", "doc.md"), oldText);
  fs.writeFileSync(path.join(dir, "b", "doc.md"), newText);
  return { dir, oldText, newText };
}

/** `git diff` of the two readings, header lines dropped. */
function gitBody(dir) {
  const args = ["-C", dir, "diff", "--no-index", "--no-color", "-U3", "a/doc.md", "b/doc.md"];
  let out = "";
  try {
    out = execFileSync("git", args, { encoding: "utf8" });
  } catch (failure) {
    // git diff exits 1 when the files differ, which is the whole point of running it.
    out = failure.stdout;
  }
  return body(out.split("\n"));
}

/** Our rendering, review notes and header lines dropped. */
function ourBody(source) {
  return body(renderUnifiedDiff(source, { path: "doc.md" }).split("\n"));
}

function body(lines) {
  const header = /^(?:diff --git|index |--- |\+\+\+ |#)/;
  return lines.filter((line) => line !== "" && !header.test(line)).join("\n");
}

function parity(name, source) {
  test(`renders exactly as git diff does: ${name}`, () => {
    const { dir } = fixture(source);
    try {
      assert.equal(ourBody(source), gitBody(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

const PROSE = [
  "# Monitor overfiring",
  "",
  "The monitor fires on 12% of benign traffic, well inside the review",
  "budget agreed with the deployment team.",
  "",
  "## Bycatch",
  "",
  "Of the cross-harm negatives, the monitor overfires at a rate we did",
  "not measure. Table 2 reports the calibrated operating points, one per",
  "model, each with a Wilson interval.",
  "",
  "## Limitations",
  "",
  "The corpus is a single month of traffic.",
  "",
];

/** The fixture with `replacements` spliced in, keyed by the line to rewrite (1-indexed). */
function marked(replacements) {
  const lines = PROSE.slice();
  for (const [lineno, text] of Object.entries(replacements)) lines[lineno - 1] = text;
  return lines.join("\n");
}

parity("one substitution inside a line", marked({ 3: "The monitor fires on {~~12%~>11.4%~~}." }));

parity(
  "two suggestions on one line collapse into a single -/+ pair",
  marked({ 3: "The monitor {~~fires~>overfires~~} on {--12%--}{++11.4%++} of benign traffic." }),
);

parity(
  "suggestions on adjacent lines group with no context between them",
  marked({ 3: "The monitor fires on {~~12%~>11.4%~~}", 4: "{--budget--}{++allowance++} agreed." }),
);

parity(
  "suggestions far apart become two hunks",
  marked({
    3: "Fires on {~~12%~>11.4%~~}.",
    14: "The corpus is {--a single month--}{++a year++}.",
  }),
);

parity(
  "a deletion spanning lines removes each of them",
  marked({
    9: "{--not measure. Table 2 reports the calibrated operating points, one per",
    10: "model, each with a Wilson interval.--}",
  }),
);

parity(
  "an insertion of whole lines adds each of them",
  marked({
    14: "The corpus is a single month of traffic.{++\n\nWe replicate on a second month.++}",
  }),
);

parity("a document ending without a newline", "one line, {~~old~>new~~}, no trailing newline");

parity(
  "a heading trailer on a hunk below it",
  marked({ 9: "{--not measure--}{++measure at 3.4%++}. Table 2 reports the points." }),
);

test("the rendering with its notes stripped is a patch git will apply", () => {
  const source = marked({
    3: "The monitor fires on {~~12%~>11.4%~~} of benign traffic, {>>recheck<<}",
    9: "{==not measure==}{>>we do now<<}. Table 2 reports {--the calibrated--} points,",
    14: "The corpus is {--a single month--}{++a full year++} of traffic.",
  });
  const { dir, oldText, newText } = fixture(source);
  try {
    const patch = renderUnifiedDiff(source, { path: "doc.md" })
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");
    fs.writeFileSync(path.join(dir, "doc.md"), oldText);
    fs.writeFileSync(path.join(dir, "patch.diff"), patch);
    execFileSync("git", ["-C", dir, "apply", "patch.diff"], { encoding: "utf8" });
    assert.equal(fs.readFileSync(path.join(dir, "doc.md"), "utf8"), newText);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
