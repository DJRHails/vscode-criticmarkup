"use strict";

/**
 * Acting on a suggestion: what one hover covers, what it offers, and the edit each offer makes.
 *
 * The unit of review is not the marker, it is the decision. A judge writes a suggestion and the
 * reason for it as two adjacent markers — `{~~old~>new~~}{>>why<<}` is what
 * `lab.utils.criticmarkup.suggestion` emits, and what the notes site writes back — so settling
 * the edit settles the note with it. Leaving the note behind would turn one decision into two
 * chores, and the second one has nothing left to decide.
 *
 * A thread that anchors to a passage (`{==quote==}{>>remark<<}`) is the other case: no edit is
 * proposed, so there is nothing to accept or reject. It resolves — the markers go, the passage
 * stays — which is the same reading `commentRemoval` has on the notes site, down to the space
 * or blank line the thread brought with it.
 *
 * Everything here is pure: `unitAt` finds what the cursor is on, `editFor` says what to splice,
 * `hoverModel` says what to show. extension.js turns the last one into a VS Code hover.
 */

const { isChange, scan, threads } = require("./criticmarkup");

/**
 * What the three actions are called where a person reads them, and the command that takes the
 * one under the cursor.
 *
 * The command names follow VS Code's own merge-conflict extension, which is the tool a reviewer
 * already knows for this shape of decision: `<action>.<what>` ids, Title Case titles, and a
 * separate command for the cursor and the selection rather than one that has to explain in its
 * title which it means.
 */
const ACTIONS = {
  accept: { command: "criticmarkup.accept.suggestion", label: "Accept" },
  reject: { command: "criticmarkup.reject.suggestion", label: "Reject" },
  resolve: { command: "criticmarkup.resolve.comment", label: "Resolve" },
};

/**
 * The bulk command ids for each action; resolving every comment in a file is not on offer.
 *
 * One dotted segment per idea, and a segment that ever needs two words hyphenates inside itself
 * the way `merge-conflict.accept.all-current` does. Ours needs no qualifier after `all`: that
 * extension has three sides to say "all" about, and this one has only suggestions.
 */
const BULK = {
  accept: { selection: "criticmarkup.accept.selection", all: "criticmarkup.accept.all" },
  reject: { selection: "criticmarkup.reject.selection", all: "criticmarkup.reject.all" },
  resolve: { selection: "criticmarkup.resolve.selection" },
};

/**
 * @typedef {object} Unit
 * @property {'change' | 'thread'} kind
 * @property {number} start Offset of the first marker in the unit.
 * @property {number} end Offset just past the last marker in the unit.
 * @property {import('./criticmarkup').Span} [span] The edit, for a change.
 * @property {import('./criticmarkup').Thread} [thread] The remark and its replies.
 */

function holds(start, end, offset) {
  return start <= offset && offset < end;
}

/** The thread written immediately after `span` to explain it, if there is one. */
function explanation(span, all) {
  return all.find((thread) => !thread.anchor && thread.start === span.end) ?? null;
}

/**
 * Every review unit in the document, in the order they are written.
 *
 * A suggestion and the note explaining it are one unit, so both offer the same actions wherever
 * you are inside them, and a bulk action cannot take the edit while leaving its reason behind.
 *
 * @param {string} source
 * @returns {Unit[]}
 */
function units(source) {
  const spans = scan(source);
  const all = threads(spans);
  const explained = new Set();
  const found = [];
  for (const span of spans.filter(isChange)) {
    const note = explanation(span, all);
    if (note) explained.add(note);
    found.push({
      kind: "change",
      start: span.start,
      end: note ? note.end : span.end,
      span,
      thread: note ?? undefined,
    });
  }
  for (const thread of all.filter((thread) => !explained.has(thread))) {
    found.push({ kind: "thread", start: thread.start, end: thread.end, thread });
  }
  return found.sort((one, other) => one.start - other.start);
}

/**
 * The review unit the cursor is inside, or null where there is nothing to decide.
 *
 * Landing on the note of an explained suggestion returns the suggestion: the two markers are
 * one decision.
 *
 * @param {string} source
 * @param {number} offset
 * @returns {Unit | null}
 */
function unitAt(source, offset) {
  return units(source).find((unit) => holds(unit.start, unit.end, offset)) ?? null;
}

/**
 * The splices `action` makes across `[start, end)`, in document order.
 *
 * A unit the range only clips is taken whole — half a marker is not a decision, and splicing one
 * would leave the other half behind as broken markup. An empty range is a bare cursor, and takes
 * the unit it sits in. Units the action does not apply to are skipped, not forced: accepting a
 * selection settles the suggestions in it and leaves the comment threads for their own Resolve.
 *
 * @param {string} source
 * @param {{start: number, end: number}} range
 * @param {'accept' | 'reject' | 'resolve'} action
 * @returns {Array<{start: number, end: number, replacement: string}>}
 */
function editsIn(source, range, action) {
  const touched = (unit) =>
    range.start === range.end
      ? holds(unit.start, unit.end, range.start)
      : unit.start < range.end && range.start < unit.end;
  return units(source)
    .filter(touched)
    .map((unit) => editFor(source, unit, action))
    .filter((edit) => edit !== null);
}

/**
 * The splice one action makes: replace `[start, end)` with `replacement`.
 *
 * @param {string} source
 * @param {Unit} unit
 * @param {'accept' | 'reject' | 'resolve'} action
 * @returns {{start: number, end: number, replacement: string} | null}
 */
function editFor(source, unit, action) {
  if (unit.kind === "change") {
    if (action === "resolve") return null;
    const replacement = action === "accept" ? unit.span.accepted : unit.span.rejected;
    return { start: unit.start, end: unit.end, replacement };
  }
  if (action !== "resolve") return null;
  return resolution(source, unit.thread);
}

/**
 * Removing a thread: an anchored one unwraps its passage, a standalone one takes with it the
 * space that attached it, or the blank line that gave it its own paragraph.
 */
function resolution(source, thread) {
  if (thread.anchor) {
    return { start: thread.anchor.start, end: thread.end, replacement: thread.anchor.text };
  }
  let start = thread.start;
  let end = thread.end;
  if (source[start - 1] === " ") start -= 1;
  else if (source.slice(end, end + 2) === "\n\n" && (start === 0 || source[start - 1] === "\n")) {
    end += 2;
  }
  return { start, end, replacement: "" };
}

/**
 * @typedef {object} HoverModel
 * @property {Array<{command: string, label: string, offset: number}>} actions
 * @property {{start: number, end: number}} range What the hover covers.
 */

/**
 * What to show over a unit: the decision, and nothing else.
 *
 * The hover used to preview the change as `-`/`+` lines and repeat the judge's reason. Both were
 * already on screen — the marker is decorated in place and its note renders beside it — and the
 * popover was big enough to cover the sentence you were reading it against (maintainer call,
 * 2026-09-16). A one-line hover sits out of the way of the words it is about.
 *
 * It also means no text the document supplied is rendered in a hover at all, which is a stronger
 * guard than escaping it was: a suggestion is untrusted input, and now none of it reaches the
 * trusted markdown.
 *
 * @param {Unit} unit
 * @returns {HoverModel}
 */
function hoverModel(unit) {
  const offer = unit.kind === "change" ? ["accept", "reject"] : ["resolve"];
  return {
    actions: offer.map((action) => ({ ...ACTIONS[action], offset: unit.start })),
    range: { start: unit.start, end: unit.end },
  };
}

module.exports = { ACTIONS, BULK, editFor, editsIn, hoverModel, unitAt, units };
