"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { annotate, criticMarkupPlugin } = require("../lib/preview");

test("a change inside one line renders as a word diff, old then new", () => {
  assert.equal(
    annotate("Fires on {~~12%~>11.4%~~} of traffic."),
    'Fires on <del class="cm cm-del">12%</del><ins class="cm cm-ins">11.4%</ins> of traffic.',
  );
});

test("a lone insertion or deletion keeps its one element", () => {
  assert.equal(annotate("a {++b++}"), 'a <ins class="cm cm-ins">b</ins>');
  assert.equal(annotate("a {--b--}"), 'a <del class="cm cm-del">b</del>');
});

test("a remark renders as a note, and its replies as replies", () => {
  const out = annotate("{==passage==}{>>tighten<<}{>>agreed<<}");
  assert.ok(out.includes('<mark class="cm cm-mark">passage</mark>'));
  assert.ok(out.includes('<span class="cm cm-note">tighten</span>'));
  assert.ok(out.includes('<span class="cm cm-note cm-reply">agreed</span>'));
});

test("a change crossing a line break renders as a hunk instead", () => {
  const out = annotate("{~~one\ntwo~>three~~}");
  assert.ok(out.includes('<span class="cm cm-hunk">'));
  assert.ok(out.includes("@@ suggestion @@"));
  assert.ok(out.includes('<span class="cm cm-row cm-del">one</span>'));
  assert.ok(out.includes('<span class="cm cm-row cm-del">two</span>'));
  assert.ok(out.includes('<span class="cm cm-row cm-ins">three</span>'));
});

test("rewriting never moves a source line, so preview scroll sync survives", () => {
  const sources = [
    "a {~~one\ntwo~>three~~} b",
    "a {++one\ntwo\nthree++} b",
    "a {--one\ntwo--} b",
    "first\n\nsecond {~~x~>y~~}\n\nthird\n",
  ];
  for (const source of sources) {
    assert.equal(
      annotate(source).split("\n").length,
      source.split("\n").length,
      `line count changed for ${JSON.stringify(source)}`,
    );
  }
});

test("a highlight crossing a line break is still not a change", () => {
  const out = annotate("{==one\ntwo==}{>>why<<}");
  assert.ok(!out.includes("cm-hunk"));
  assert.ok(out.includes('<mark class="cm cm-mark">one\ntwo</mark>'));
});

test("a marker holding a blank line falls back to inline, which markdown can hold", () => {
  const out = annotate("{--one\n\ntwo--}");
  assert.ok(!out.includes("cm-hunk"));
  assert.ok(out.startsWith('<del class="cm cm-del">'));
});

test("markers quoted in a code fence or a code span are left alone", () => {
  const fenced = ["```md", "{++sample++}", "```", ""].join("\n");
  assert.equal(annotate(fenced), fenced);
  assert.equal(annotate("write `{++this++}` to suggest"), "write `{++this++}` to suggest");
});

test("a document with no markup comes back untouched", () => {
  const plain = "# Title\n\nSome prose with { a brace.\n";
  assert.equal(annotate(plain), plain);
});

test("the plugin installs one core rule ahead of normalize", () => {
  const calls = [];
  const md = {
    core: { ruler: { before: (anchor, name, rule) => calls.push([anchor, name, rule]) } },
  };
  criticMarkupPlugin(md);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["normalize", "criticmarkup"]);
  const state = { src: "a {++b++}" };
  calls[0][2](state);
  assert.equal(state.src, 'a <ins class="cm cm-ins">b</ins>');
});
