"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { editFor, editsIn, hoverModel, unitAt } = require("../lib/review");

/** Apply what the action at `offset` would splice, so a test reads as the text it leaves. */
function act(source, offset, action) {
  const unit = unitAt(source, offset);
  const edit = editFor(source, unit, action);
  if (!edit) return null;
  return source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
}

/** Apply every splice an action makes across a range, back to front so offsets keep. */
function actOver(source, range, action) {
  return editsIn(source, range, action)
    .reverse()
    .reduce(
      (text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end),
      source,
    );
}

/** The range covering the whole of `source`. */
function everywhere(source) {
  return { start: 0, end: source.length };
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

test("accepting a selection settles every suggestion it touches, and nothing outside it", () => {
  const source = "One {--a--}, two {~~b~>c~~}, three {++d++}.";
  const range = { start: source.indexOf("{--"), end: source.indexOf("{~~") + 4 };
  assert.equal(actOver(source, range, "accept"), "One , two c, three {++d++}.");
});

test("a selection that clips a marker still takes the whole decision", () => {
  // Half a marker is not a decision, and splicing one would leave broken markup behind.
  const source = "Fires on {~~12%~>11.4%~~} of traffic.";
  const clipped = { start: source.indexOf("12%"), end: source.indexOf("12%") + 2 };
  assert.equal(actOver(source, clipped, "accept"), "Fires on 11.4% of traffic.");
});

test("accepting or rejecting the file settles every suggestion in it", () => {
  const source = "One {--a--}, two {~~b~>c~~}, three {++d++}.\n";
  assert.equal(actOver(source, everywhere(source), "accept"), "One , two c, three d.\n");
  assert.equal(actOver(source, everywhere(source), "reject"), "One a, two b, three .\n");
});

test("a bulk decision leaves comment threads for their own Resolve", () => {
  // A remark proposed no edit, so there is nothing in it to accept or reject; sweeping the
  // reviewer's notes away as a side effect of taking their suggestions is nobody's decision.
  const source = "A {++new++} claim. {==passage==}{>>is this right?<<}";
  assert.equal(
    actOver(source, everywhere(source), "accept"),
    "A new claim. {==passage==}{>>is this right?<<}",
  );
  assert.equal(actOver(source, everywhere(source), "resolve"), "A {++new++} claim. passage");
});

test("two cursors inside one suggestion ask for one splice, not two", () => {
  const source = "Fires on {~~12%~>11.4%~~} of traffic.";
  const inside = source.indexOf("12%");
  assert.equal(editsIn(source, { start: inside, end: inside }, "accept").length, 1);
  assert.equal(editsIn(source, { start: inside, end: inside + 1 }, "accept").length, 1);
});

test("a range with no marker in it asks for nothing", () => {
  const source = "Fires on {~~12%~>11.4%~~} of traffic.";
  assert.deepEqual(editsIn(source, { start: 0, end: 5 }, "accept"), []);
});

test("the hover covers the whole decision, marker and its reason together", () => {
  const source = "Fires on {~~12%~>11.4%~~}{>>recompute<<}{>>done<<} of traffic.";
  const model = hoverModel(unitAt(source, 12));
  assert.deepEqual(model.range, {
    start: source.indexOf("{~~"),
    end: source.indexOf("{>>done<<}") + "{>>done<<}".length,
  });
});

test("a thread offers only Resolve", () => {
  const model = hoverModel(unitAt("{==passage==}{>>one<<}{>>two<<}", 16));
  assert.deepEqual(
    model.actions.map((action) => action.command),
    ["criticmarkup.resolve"],
  );
});

test("the hover model carries nothing but the decision and its range", () => {
  // No text the document supplied reaches a trusted hover, so there is nothing to escape, and
  // no preview to cover the sentence the suggestion is about.
  const model = hoverModel(unitAt("a {>>see [this](command:x)<<}", 8));
  assert.deepEqual(Object.keys(model).sort(), ["actions", "range"]);
});
