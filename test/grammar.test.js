"use strict";

/**
 * The injection grammar's one job: markdown must not read a substitution's tildes as a
 * strikethrough.
 *
 * `{~~12%~>11.4%~~}` is, to VS Code's markdown grammar, an ordinary `~~…~~` run, so the theme
 * strikes the whole marker through — including the new side, which is the text the suggestion is
 * asking *for*. Struck-through green reads as "delete this", the opposite of what it means.
 *
 * These tests hold both halves of the fix: the delimiters are claimed so the strikethrough rule
 * can never pair them, and a real strikethrough — inside a marker body or outside a marker
 * entirely — is left to markdown, because that one is the author's.
 *
 * The tokenizer itself is not run (that would mean an oniguruma build, and this extension has no
 * dependencies). Instead markdown's own rule is applied as VS Code writes it, with its possessive
 * `*+` relaxed to `*` because JavaScript has no possessive quantifier, and the injection is
 * simulated by blanking what its patterns match — which is what the tokenizer does when a
 * left-injected pattern claims those characters first.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { scan } = require("../lib/criticmarkup");

const ROOT = path.join(__dirname, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const [CONTRIBUTED] = MANIFEST.contributes.grammars ?? [];
const GRAMMAR = JSON.parse(fs.readFileSync(path.join(ROOT, CONTRIBUTED?.path ?? ""), "utf8"));

/** `markup.strikethrough.markdown` from VS Code's markdown grammar, possessive quantifier aside. */
const STRIKETHROUGH =
  /(?<!\\)(~{2,})(?!(?<=\w~~)_)((?:[^~]|(?!(?<![~\\])\1(?!~))~)*)(\1)(?!(?<=_\1)\w)/g;

/** What markdown would strike through in `text`. */
function struck(text) {
  return [...text.matchAll(STRIKETHROUGH)].map((match) => match[0]);
}

/** `text` as the rest of the grammar sees it once the injection has claimed what it matches. */
function afterInjection(text) {
  let left = text;
  for (const pattern of GRAMMAR.patterns) {
    left = left.replace(new RegExp(pattern.match, "g"), (claimed) => " ".repeat(claimed.length));
  }
  return left;
}

test("markdown strikes a whole substitution, new side included, until the injection claims it", () => {
  const source = "The monitor fires on {~~12%~>11.4%~~} of benign traffic.";
  assert.deepEqual(struck(source), ["~~12%~>11.4%~~"]);
  assert.deepEqual(struck(afterInjection(source)), []);
});

test("two substitutions on a line leave no tildes to pair, with each other or across", () => {
  const source = "The monitor {~~fires~>overfires~~} on {~~12%~>11.4%~~} of traffic.";
  assert.deepEqual(struck(afterInjection(source)), []);
});

test("every tilde a substitution carries is claimed, on one line or across two", () => {
  const source = "Fires on {~~12%~>11.4%~~}.\nThe corpus is {~~one\nmonth~>one year~~}.\n";
  const spans = scan(source).filter((span) => span.kind === "substitution");
  assert.equal(spans.length, 2);
  const left = afterInjection(source);
  for (const span of spans) {
    assert.ok(!left.slice(span.start, span.end).includes("~~"), `tildes left in ${span.source}`);
  }
});

test("a real strikethrough outside a marker is the author's, and is left alone", () => {
  const source = "The claim was ~~overstated~~ and the {++revised++} number stands.";
  assert.equal(afterInjection(source), source);
  assert.deepEqual(struck(source), ["~~overstated~~"]);
});

test("a real strikethrough inside a marker body still strikes through", () => {
  const source = "{++the ~~old~~ claim++}";
  assert.deepEqual(struck(afterInjection(source)), ["~~old~~"]);
});

test("the injection runs before markdown's own rules and keeps out of code", () => {
  assert.match(GRAMMAR.injectionSelector, /^L:text\.html\.markdown\b/);
  for (const quoted of ["markup.fenced_code", "markup.raw", "markup.inline.raw", "meta.embedded"]) {
    assert.ok(GRAMMAR.injectionSelector.includes(quoted), `${quoted} is not excluded`);
  }
});

test("the manifest injects the grammar into markdown, and only there", () => {
  assert.equal(MANIFEST.contributes.grammars.length, 1);
  assert.equal(CONTRIBUTED.scopeName, GRAMMAR.scopeName);
  assert.deepEqual(CONTRIBUTED.injectTo, ["text.html.markdown"]);
  assert.ok(fs.existsSync(path.join(ROOT, CONTRIBUTED.path)));
});
