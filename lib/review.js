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

/** What the three actions are called where a person reads them. */
const ACTIONS = {
  accept: { command: "criticmarkup.accept", label: "Accept" },
  reject: { command: "criticmarkup.reject", label: "Reject" },
  resolve: { command: "criticmarkup.resolve", label: "Resolve" },
};

const TITLES = {
  insertion: "Insertion",
  deletion: "Deletion",
  substitution: "Substitution",
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
 * The review unit the cursor is inside, or null where there is nothing to decide.
 *
 * Landing on the note of an explained suggestion returns the suggestion: the two markers are
 * one decision, and both offer the same actions wherever you hover over them.
 *
 * @param {string} source
 * @param {number} offset
 * @returns {Unit | null}
 */
function unitAt(source, offset) {
  const spans = scan(source);
  const all = threads(spans);
  for (const span of spans.filter(isChange)) {
    const note = explanation(span, all);
    const end = note ? note.end : span.end;
    if (holds(span.start, end, offset)) {
      return { kind: "change", start: span.start, end, span, thread: note ?? undefined };
    }
  }
  for (const thread of all) {
    if (!holds(thread.start, thread.end, offset)) continue;
    if (spans.some((span) => isChange(span) && explanation(span, all) === thread)) continue;
    return { kind: "thread", start: thread.start, end: thread.end, thread };
  }
  return null;
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

/** Markdown characters in text a document supplied, which must not become markup in a hover. */
function escapeMarkdown(text) {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, (char) => `\\${char}`);
}

/** The marker's own before and after, as the `-`/`+` lines of a diff. */
function preview(span) {
  const rows = [];
  for (const line of span.rejected ? span.rejected.split("\n") : []) rows.push(`-${line}`);
  for (const line of span.accepted ? span.accepted.split("\n") : []) rows.push(`+${line}`);
  return rows.join("\n");
}

/**
 * @typedef {object} HoverModel
 * @property {string} title What kind of decision this is.
 * @property {string} diff The `-`/`+` preview, empty for a thread.
 * @property {string[]} notes The remark and its replies, markdown-escaped.
 * @property {Array<{command: string, label: string, offset: number}>} actions
 * @property {{start: number, end: number}} range What the hover covers.
 */

/**
 * What to show over a unit: what it would do, why (if the judge said), and the actions.
 *
 * @param {Unit} unit
 * @returns {HoverModel}
 */
function hoverModel(unit) {
  const offer = unit.kind === "change" ? ["accept", "reject"] : ["resolve"];
  const replies = unit.thread ? unit.thread.comments.length - 1 : 0;
  return {
    title: unit.kind === "change" ? TITLES[unit.span.kind] : threadTitle(unit.thread, replies),
    diff: unit.kind === "change" ? preview(unit.span) : "",
    notes: (unit.thread?.comments ?? []).map((comment) => escapeMarkdown(comment.text)),
    actions: offer.map((action) => ({ ...ACTIONS[action], offset: unit.start })),
    range: { start: unit.start, end: unit.end },
  };
}

function threadTitle(thread, replies) {
  const anchored = thread.anchor ? "Comment on this passage" : "Comment";
  return replies ? `${anchored} — ${replies} ${replies === 1 ? "reply" : "replies"}` : anchored;
}

module.exports = { ACTIONS, editFor, escapeMarkdown, hoverModel, unitAt };
