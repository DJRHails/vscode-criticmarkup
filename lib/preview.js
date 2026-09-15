"use strict";

/**
 * CriticMarkup in the built-in Markdown preview, rendered the two ways git renders a diff.
 *
 * git itself has two diff renderings, and which one reads better depends on the size of the
 * change — so this uses both, picked by the same rule git's own advice gives:
 *
 * - A change inside one line renders like `git diff --word-diff`: the old words struck through
 *   in red, the new words in green, in place, so the sentence still reads as a sentence.
 * - A change crossing a line break renders like `git diff` proper: a hunk, `@@ suggestion @@`
 *   over `-` and `+` lines. Once a suggestion rewrites whole lines, reading it inline means
 *   reading two interleaved versions of a paragraph, which is exactly what the line-oriented
 *   rendering exists to avoid.
 *
 * A `{>>remark<<}` is a review note, not an edit, so it renders as a note beside its anchor —
 * never as an insertion, which would claim the reviewer proposed their own comment as prose.
 *
 * The rewrite is applied to the markdown source before parsing, which keeps markers that span
 * inline constructs (`{~~a *b*~>c~~}`) working, and it holds the document's line count fixed so
 * the preview's scroll sync keeps pointing at the right source line.
 */

const { isChange, scan, threads, unfencedRegions } = require("./criticmarkup");

/** A run of backticks and whatever it fences off — a quoted sample, never a suggestion. */
const CODE_SPAN = /(`+)[^]*?\1/g;

/** A blank line inside a marker would split the injected element across two markdown blocks. */
const BLANK_LINE = /\n[ \t]*\n/;

function protectedRanges(source) {
  const ranges = [];
  let at = 0;
  for (const [start, end] of unfencedRegions(source)) {
    if (start > at) ranges.push([at, start]);
    for (const match of source.slice(start, end).matchAll(CODE_SPAN)) {
      ranges.push([start + match.index, start + match.index + match[0].length]);
    }
    at = end;
  }
  if (at < source.length) ranges.push([at, source.length]);
  return ranges;
}

function overlaps(span, ranges) {
  return ranges.some(([start, end]) => span.start < end && start < span.end);
}

/** Join `parts`, spending `newlines` of the gaps between them so the line count survives. */
function joinKeepingLines(parts, newlines) {
  const gaps = parts.length - 1;
  return parts.map((part, i) => (i < gaps && gaps - i <= newlines ? `${part}\n` : part)).join("");
}

function element(tag, cls, body) {
  return `<${tag} class="cm ${cls}">${body}</${tag}>`;
}

/** One `-`/`+` hunk, for a suggestion that rewrites whole lines. */
function hunk(span) {
  const rows = ['<span class="cm-hunk-head">@@ suggestion @@</span>'];
  for (const line of span.rejected ? span.rejected.split("\n") : []) {
    rows.push(element("span", "cm-row cm-del", line));
  }
  for (const line of span.accepted ? span.accepted.split("\n") : []) {
    rows.push(element("span", "cm-row cm-ins", line));
  }
  const newlines = (span.source.match(/\n/g) ?? []).length;
  return `<span class="cm cm-hunk">${joinKeepingLines(rows, newlines)}</span>`;
}

/** The inline, word-diff rendering of one marker. */
function inline(span, reply) {
  if (span.kind === "insertion") return element("ins", "cm-ins", span.text);
  if (span.kind === "deletion") return element("del", "cm-del", span.text);
  if (span.kind === "highlight") return element("mark", "cm-mark", span.text);
  if (span.kind === "comment") {
    return element("span", reply ? "cm-note cm-reply" : "cm-note", span.text);
  }
  return element("del", "cm-del", span.before) + element("ins", "cm-ins", span.after);
}

function rendered(span, replies) {
  // A highlight spanning lines is still not a change: rendering it as a hunk would print the
  // same passage as both the old and the new side.
  const crossesLines =
    isChange(span) && (span.rejected.includes("\n") || span.accepted.includes("\n"));
  // A marker holding a blank line cannot become one element: markdown ends the block there and
  // the tags would never close. Such a marker is malformed anyway — the composers refuse it.
  if (crossesLines && !BLANK_LINE.test(span.source)) return hunk(span);
  return inline(span, replies.has(span));
}

/**
 * `source` with every marker replaced by the HTML that renders it, line count unchanged.
 *
 * @param {string} source
 * @returns {string}
 */
function annotate(source) {
  const ranges = protectedRanges(source);
  const spans = scan(source).filter((span) => !overlaps(span, ranges));
  const replies = new Set(threads(spans).flatMap((thread) => thread.comments.slice(1)));
  const pieces = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(source.slice(cursor, span.start), rendered(span, replies));
    cursor = span.end;
  }
  pieces.push(source.slice(cursor));
  return pieces.join("");
}

/**
 * The markdown-it plugin VS Code's preview loads (see `contributes.markdown.markdownItPlugins`).
 *
 * @param {{core: {ruler: {before: Function}}}} md
 */
function criticMarkupPlugin(md) {
  md.core.ruler.before("normalize", "criticmarkup", (state) => {
    if (state.src.includes("{")) state.src = annotate(state.src);
  });
  return md;
}

module.exports = { annotate, criticMarkupPlugin };
