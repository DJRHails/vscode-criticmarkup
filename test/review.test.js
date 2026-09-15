"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { editFor, escapeMarkdown, hoverModel, unitAt } = require("../lib/review");

/** Apply what the action at `offset` would splice, so a test reads as the text it leaves. */
function act(source, offset, action) {
  const unit = unitAt(source, offset);
  const edit = editFor(source, unit, action);
  if (!edit) return null;
  return source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
}

test("accepting a substitution leaves the new text, rejecting leaves the old", () => {
  const source = "Fires on {~~12%~>11.4%~~} of traffic.";
  assert.equal(act(source, 12, "accept"), "Fires on 11.4% of traffic.");
  assert.equal(act(source, 12, "reject"), "Fires on 12% of traffic.");
});

test("an insertion and a deletion resolve the same way round", () => {
  assert.equal(act("a {++b++} c", 5, "accept"), "a b c");
  assert.equal(act("a {++b++} c", 5, "reject"), "a  c");
  assert.equal(act("a {--b--} c", 5, "accept"), "a  c");
  assert.equal(act("a {--b--} c", 5, "reject"), "a b c");
});

test("settling an explained suggestion takes its note with it", () => {
  const source = "Fires on {~~12%~>11.4%~~}{>>recompute from the census<<} of traffic.";
  assert.equal(act(source, 12, "accept"), "Fires on 11.4% of traffic.");
  assert.equal(act(source, 12, "reject"), "Fires on 12% of traffic.");
});

test("the note of an explained suggestion offers the suggestion's own actions", () => {
  const source = "Fires on {~~12%~>11.4%~~}{>>recompute<<} of traffic.";
  const onTheNote = unitAt(source, source.indexOf("{>>") + 3);
  assert.equal(onTheNote.kind, "change");
  assert.deepEqual(
    hoverModel(onTheNote).actions.map((action) => action.label),
    ["Accept", "Reject"],
  );
  assert.equal(act(source, source.indexOf("{>>") + 3, "accept"), "Fires on 11.4% of traffic.");
});

test("a suggestion is not swallowed by a thread that anchors to something else", () => {
  const source = "a {--b--}{==c==}{>>about c<<} d";
  assert.equal(act(source, 4, "accept"), "a {==c==}{>>about c<<} d");
  assert.equal(act(source, source.indexOf("about"), "resolve"), "a {--b--}c d");
});

test("resolving an anchored thread keeps the passage it was about", () => {
  const source = "The corpus is {==a single month==}{>>which month?<<} of traffic.";
  assert.equal(
    act(source, source.indexOf("which"), "resolve"),
    "The corpus is a single month of traffic.",
  );
});

test("resolving a standalone thread takes the space that attached it", () => {
  assert.equal(act("prose here {>>a remark<<}", 15, "resolve"), "prose here");
});

test("resolving a thread in its own paragraph takes the blank line too", () => {
  const source = "first\n\n{>>a remark<<}\n\nsecond\n";
  assert.equal(act(source, 10, "resolve"), "first\n\nsecond\n");
});

test("a thread offers nothing to accept, and a change nothing to resolve", () => {
  const thread = unitAt("a {>>note<<}", 5);
  assert.equal(editFor("a {>>note<<}", thread, "accept"), null);
  const change = unitAt("a {++b++}", 5);
  assert.equal(editFor("a {++b++}", change, "resolve"), null);
});

test("prose carrying no marker has nothing to act on", () => {
  assert.equal(unitAt("just prose", 4), null);
  assert.equal(unitAt("a {++b++} c", 0), null);
});

test("the hover previews the change as diff lines and carries the reasons", () => {
  const source = "Fires on {~~12%~>11.4%~~}{>>recompute<<}{>>done<<} of traffic.";
  const model = hoverModel(unitAt(source, 12));
  assert.equal(model.title, "Substitution");
  assert.equal(model.diff, "-12%\n+11.4%");
  assert.deepEqual(model.notes, ["recompute", "done"]);
  assert.deepEqual(model.range, {
    start: source.indexOf("{~~"),
    end: source.indexOf("{>>done<<}") + "{>>done<<}".length,
  });
});

test("a thread hover counts its replies and previews no change", () => {
  const source = "{==passage==}{>>one<<}{>>two<<}";
  const model = hoverModel(unitAt(source, 16));
  assert.equal(model.title, "Comment on this passage — 1 reply");
  assert.equal(model.diff, "");
  assert.deepEqual(
    model.actions.map((action) => action.command),
    ["criticmarkup.resolve"],
  );
});

test("an insertion previews as + lines only, a deletion as - lines only", () => {
  assert.equal(hoverModel(unitAt("a {++new\nlines++}", 5)).diff, "+new\n+lines");
  assert.equal(hoverModel(unitAt("a {--gone--}", 5)).diff, "-gone");
});

test("text from the document cannot smuggle markup into a hover", () => {
  assert.equal(escapeMarkdown("[click](command:evil)"), "\\[click\\]\\(command:evil\\)");
  const model = hoverModel(unitAt("a {>>see [this](command:x)<<}", 8));
  assert.ok(!model.notes[0].includes("](command:"));
});
