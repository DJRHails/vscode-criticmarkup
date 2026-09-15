"use strict";

/**
 * Run the shipped injection through the real TextMate tokenizer against VS Code's real markdown
 * grammar, and report what it does to every context a marker can sit in.
 *
 * `npm test` cannot do this: tokenization needs oniguruma, a native/wasm dependency this
 * extension deliberately does not carry. So the suite reasons about the strikethrough rule as a
 * regex, and this script — run by hand, from a scratch directory — checks the real thing. It is
 * not idle rigour: the regex tests passed on a v0.3.0 selector that injected at the document
 * root, and only this script showed that a line *opening* with `{~~` then never entered
 * `meta.paragraph.markdown` and lost every other inline rule.
 *
 *     mkdir -p /tmp/scope-check && cd /tmp/scope-check && npm install vscode-textmate vscode-oniguruma
 *     curl -sLo md.json https://raw.githubusercontent.com/microsoft/vscode/main/extensions/markdown-basics/syntaxes/markdown.tmLanguage.json
 *     NODE_PATH=$PWD/node_modules node <checkout>/tools/scope-check.js md.json
 *
 * A markdown file can be passed as a second argument to report on its own lines instead.
 */

const fs = require("node:fs");
const path = require("node:path");
const oniguruma = require("vscode-oniguruma");
const vsctm = require("vscode-textmate");

const MARKDOWN = "text.html.markdown";
const MARKDOWN_PATH = process.argv[2];
const SUBJECT = process.argv[3];
const INJECTION_PATH = path.join(__dirname, "..", "syntaxes", "substitution-tildes.injection.json");
const INJECTION = JSON.parse(fs.readFileSync(INJECTION_PATH, "utf8")).scopeName;

/** Each case: a document, and whether the marker in it is prose or a quoted sample. */
const CASES = {
  "marker opens a paragraph": {
    doc: "{~~old~>new~~} and **bold** here.\n",
    prose: true,
    keeps: "meta.paragraph",
  },
  "marker mid-paragraph": {
    doc: "Fires on {~~12%~>11.4%~~} of traffic.\n",
    prose: true,
    keeps: "meta.paragraph",
  },
  heading: { doc: "## A heading with {~~old~>new~~}\n", prose: true, keeps: "markup.heading" },
  "list item": { doc: "- an item with {~~old~>new~~}\n", prose: true, keeps: "markup.list" },
  quote: { doc: "> a quote with {~~old~>new~~}\n", prose: true, keeps: "markup.quote" },
  "table cell": {
    doc: "| harm | share |\n| --- | --- |\n| cyber | {~~12%~>11.4%~~} |\n",
    prose: true,
    keeps: "markup.table",
  },
  "substitution across lines": {
    doc: "The corpus is {~~one\nmonth~>one year~~} of traffic.\n",
    prose: true,
    keeps: "meta.paragraph",
  },
  "fenced sample": {
    doc: "```md\n{~~old~>new~~}\n```\n",
    prose: false,
    keeps: "markup.fenced_code",
  },
  "indented sample": { doc: "prose\n\n    {~~old~>new~~}\n", prose: false, keeps: "markup.raw" },
  "code span sample": {
    doc: "an inline `{~~old~>new~~}` sample\n",
    prose: false,
    keeps: "markup.inline.raw",
  },
  "the author's own strikethrough": {
    doc: "The claim was ~~overstated~~ and {++revised++}.\n",
    prose: null,
    keeps: "meta.paragraph",
  },
};

const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
const onigLib = oniguruma.loadWASM(wasm.buffer).then(() => ({
  createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
  createOnigString: (text) => new oniguruma.OnigString(text),
}));

function read(file) {
  return vsctm.parseRawGrammar(fs.readFileSync(file, "utf8"), file);
}

async function markdownGrammar(injected) {
  const registry = new vsctm.Registry({
    onigLib,
    loadGrammar: async (scope) => {
      if (scope === MARKDOWN) return read(MARKDOWN_PATH);
      if (scope === INJECTION && injected) return read(INJECTION_PATH);
      return null;
    },
    getInjections: (scope) => (injected && scope === MARKDOWN ? [INJECTION] : undefined),
  });
  return registry.loadGrammar(MARKDOWN);
}

/** Every scope the grammar puts anywhere in `doc`. */
function scopesOf(grammar, doc) {
  let stack = vsctm.INITIAL;
  const scopes = [];
  for (const line of doc.split("\n")) {
    const tokenized = grammar.tokenizeLine(line, stack);
    stack = tokenized.ruleStack;
    scopes.push(...tokenized.tokens.flatMap((token) => token.scopes));
  }
  return scopes;
}

/** What went wrong in `scopes`, or nothing if the case came out as it should. */
function faults(scopes, when) {
  const has = (prefix) => scopes.some((scope) => scope.startsWith(prefix));
  const struck = has("markup.strikethrough");
  const claimed = has("punctuation.definition.criticmarkup");
  const wrong = [];
  if (!has(when.keeps)) wrong.push(`lost ${when.keeps}`);
  if (when.prose === null) {
    if (!struck) wrong.push("the author's strikethrough was swallowed");
    if (claimed) wrong.push("claimed prose that is not a marker");
    return wrong;
  }
  if (when.prose && struck) wrong.push("still struck through");
  if (when.prose && !claimed) wrong.push("delimiters not claimed");
  if (!when.prose && claimed) wrong.push("claimed a quoted sample");
  return wrong;
}

async function reportCases() {
  const grammar = await markdownGrammar(true);
  let failed = 0;
  for (const [label, when] of Object.entries(CASES)) {
    const wrong = faults(scopesOf(grammar, when.doc), when);
    failed += wrong.length ? 1 : 0;
    console.log(
      `  ${wrong.length ? "FAIL" : "ok  "} ${label}${wrong.length ? `: ${wrong.join(", ")}` : ""}`,
    );
  }
  console.log(failed ? `\n${failed} case(s) failed` : "\nall cases ok");
  process.exitCode = failed ? 1 : 0;
}

/** Whether each line of `doc` carries a scope, with the rule stack carried line to line. */
function perLine(grammar, doc, prefix) {
  let stack = vsctm.INITIAL;
  return doc.split("\n").map((line) => {
    const tokenized = grammar.tokenizeLine(line, stack);
    stack = tokenized.ruleStack;
    return tokenized.tokens.some((token) => token.scopes.some((scope) => scope.startsWith(prefix)));
  });
}

/** For a real document: the lines markdown would strike through, with and without the injection. */
async function reportFile(file) {
  const doc = fs.readFileSync(file, "utf8");
  const before = perLine(await markdownGrammar(false), doc, "markup.strikethrough");
  const after = perLine(await markdownGrammar(true), doc, "markup.strikethrough");
  const lines = doc.split("\n");
  let fixed = 0;
  before.forEach((wasStruck, index) => {
    if (!wasStruck && !after[index]) return;
    fixed += wasStruck && !after[index] ? 1 : 0;
    const state = after[index] ? "STILL STRUCK" : "fixed";
    console.log(`  line ${index + 1} ${state}: ${lines[index].slice(0, 60)}…`);
  });
  console.log(`\n${fixed} line(s) no longer struck through`);
}

async function main() {
  if (!MARKDOWN_PATH) {
    console.error("usage: scope-check.js <markdown.tmLanguage.json> [file.md]");
    process.exitCode = 2;
    return;
  }
  await (SUBJECT ? reportFile(SUBJECT) : reportCases());
}

main();
