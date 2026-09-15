"use strict";

/**
 * CriticMarkup scanning and resolution.
 *
 * The vocabulary (criticmarkup.com): `{++inserted++}`, `{--deleted--}`, `{~~old~>new~~}`,
 * `{>>remark<<}`, `{==anchor==}`. Every reader here is deliberately the same reader as
 * touchstone's `site/src/lib/critic.ts` and `lab.utils.criticmarkup` — same alternation, same
 * lazy bodies, same accept/reject readings, same fence skipping — because a rendering that
 * disagreed with the tool that resolves the file would show a change nobody is about to make.
 */

// One alternation per kind. Bodies are lazy so two adjacent markers never merge into one, and
// `[^]` (any character, newlines included) lets a body run across lines.
const MARKER = new RegExp(
  [
    /\{\+\+([^]+?)\+\+\}/, // {++inserted++}
    /\{--([^]+?)--\}/, // {--deleted--}
    /\{~~([^]+?)~>([^]+?)~~\}/, // {~~old~>new~~}
    /\{>>([^]+?)<<\}/, // {>>remark<<}
    /\{==([^]+?)==\}/, // {==anchor==}
  ]
    .map((re) => re.source)
    .join("|"),
  "g",
);

// A marker opener, whichever kind. Detection is deliberately more paranoid than MARKER: a
// marker left unterminated by a hand edit still counts as markup being present.
const ANY_OPENER = /\{\+\+|\{--|\{~~|\{>>|\{==/;

// A fenced code block's opening or closing line, as manuscript/sync_gdoc.py matches it.
const FENCE = /^\s*(?:```+|~~~+)/;

/**
 * @typedef {'insertion' | 'deletion' | 'substitution' | 'comment' | 'highlight'} SpanKind
 *
 * @typedef {object} Span
 * @property {SpanKind} kind
 * @property {number} start Offset of the marker's opening brace.
 * @property {number} end Offset just past the marker's closing brace.
 * @property {string} source The whole marker, braces included.
 * @property {string} text Body text; empty for a substitution.
 * @property {string} before A substitution's old side; empty otherwise.
 * @property {string} after A substitution's new side; empty otherwise.
 * @property {string} accepted What the marker leaves behind when the suggestion is taken.
 * @property {string} rejected What it leaves behind when the suggestion is turned down.
 */

/** @returns {Span} */
function spanFromMatch(match, base) {
  const [source, inserted, deleted, oldSide, newSide, remark, anchor] = match;
  const at = { start: base + match.index, end: base + match.index + source.length, source };
  const plain = { ...at, before: "", after: "" };
  if (inserted !== undefined) {
    return { kind: "insertion", text: inserted, accepted: inserted, rejected: "", ...plain };
  }
  if (deleted !== undefined) {
    return { kind: "deletion", text: deleted, accepted: "", rejected: deleted, ...plain };
  }
  if (oldSide !== undefined) {
    const sides = { before: oldSide, after: newSide };
    return {
      kind: "substitution",
      text: "",
      accepted: newSide,
      rejected: oldSide,
      ...at,
      ...sides,
    };
  }
  if (remark !== undefined) {
    return { kind: "comment", text: remark, accepted: "", rejected: "", ...plain };
  }
  return { kind: "highlight", text: anchor, accepted: anchor, rejected: anchor, ...plain };
}

/**
 * `[start, end)` offsets of the stretches of `text` outside fenced code blocks.
 *
 * A marker written inside a fence is a quoted sample — the methods appendix showing the
 * syntax — not a suggestion, and neither the resolver nor this renderer touches it.
 *
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function unfencedRegions(text) {
  /** @type {Array<[number, number]>} */
  const regions = [];
  let cursor = 0;
  let offset = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      if (inFence) cursor = offset + line.length + 1;
      else regions.push([cursor, offset]);
      inFence = !inFence;
    }
    offset += line.length + 1;
  }
  if (!inFence) regions.push([cursor, text.length]);
  return regions;
}

/**
 * Every marker in `text` outside fenced code blocks, in document order.
 *
 * @param {string} text
 * @returns {Span[]}
 */
function scan(text) {
  if (!text.includes("{")) return [];
  /** @type {Span[]} */
  const spans = [];
  for (const [start, end] of unfencedRegions(text)) {
    for (const match of text.slice(start, end).matchAll(MARKER)) {
      spans.push(spanFromMatch(match, start));
    }
  }
  return spans;
}

/** Whether `text` carries any CriticMarkup, terminated or not. */
function hasMarkup(text) {
  return ANY_OPENER.test(text);
}

/**
 * Markers whose body opens another marker — markup no single pass can resolve.
 *
 * `{++new {>>why<<} text++}` reads as one insertion whose accepted text still carries a
 * comment, so the inner marker only surfaces after the outer one is taken. The manuscript hook
 * refuses this shape; the renderer reports it rather than quietly showing one of the readings.
 *
 * @param {string} text
 * @returns {Span[]}
 */
function nestedSpans(text) {
  return scan(text).filter((span) => ANY_OPENER.test(span.source.slice(1)));
}

/** Whether the span changes the text — a comment and a highlight do not. */
function isChange(span) {
  return span.accepted !== span.rejected;
}

function resolve(text, reading) {
  const pieces = [];
  let cursor = 0;
  for (const span of scan(text)) {
    pieces.push(text.slice(cursor, span.start), reading(span));
    cursor = span.end;
  }
  pieces.push(text.slice(cursor));
  return pieces.join("");
}

/** The document with every suggestion taken. */
function acceptAll(text) {
  return resolve(text, (span) => span.accepted);
}

/** The document with every suggestion turned down — the prose the suggestions were made against. */
function rejectAll(text) {
  return resolve(text, (span) => span.rejected);
}

/**
 * @typedef {object} Thread
 * @property {Span | null} anchor The `{==passage==}` the thread hangs off, when it has one.
 * @property {Span[]} comments The remark and its replies, in order.
 * @property {number} start Offset where the thread begins (its anchor, if any).
 * @property {number} end Offset just past the last reply.
 */

/**
 * Adjacent comments chained into threads, each with its anchoring highlight when it has one.
 *
 * `{==quote==}{>>remark<<}{>>reply<<}` is one thread, exactly as the notes site reads it: a
 * comment touching the previous comment end-to-start is a reply to it.
 *
 * @param {Span[]} spans
 * @returns {Thread[]}
 */
function threads(spans) {
  /** @type {Thread[]} */
  const found = [];
  spans.forEach((span, i) => {
    if (span.kind !== "comment") return;
    const previous = spans[i - 1];
    const last = found[found.length - 1];
    if (last && previous && previous.kind === "comment" && previous.end === span.start) {
      last.comments.push(span);
      last.end = span.end;
      return;
    }
    const anchored = previous && previous.kind === "highlight" && previous.end === span.start;
    found.push({
      anchor: anchored ? previous : null,
      comments: [span],
      start: anchored ? previous.start : span.start,
      end: span.end,
    });
  });
  return found;
}

module.exports = {
  MARKER,
  acceptAll,
  hasMarkup,
  isChange,
  nestedSpans,
  rejectAll,
  scan,
  threads,
  unfencedRegions,
};
