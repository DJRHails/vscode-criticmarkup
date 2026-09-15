"use strict";

/**
 * Where to paint what, when the marked-up source itself is what you are reading.
 *
 * The editor cannot reflow prose into `-`/`+` lines, so in the source view the diff shows up as
 * colour: the old side struck through in the theme's own removed-text red, the new side in its
 * inserted-text green — the colours the diff editor two tabs over is already using. That is the
 * one thing a TextMate grammar cannot do, and why this extension does not ship one: a grammar
 * can only name scopes like `criticmarkup.addition`, which no theme has ever heard of, so the
 * markup comes out unstyled in every theme but the handful that opted in.
 *
 * Delimiters are dimmed rather than hidden. Hiding them (the `display: none` decoration trick)
 * reads well until you edit the line: the cursor walks through characters that are not there,
 * and a half-typed marker vanishes mid-keystroke.
 */

const { scan, threads } = require("./criticmarkup");

/** Every marker opens and closes with three characters; only `~>` inside a substitution is two. */
const DELIMITER = 3;
const ARROW = 2;

/**
 * @typedef {{start: number, end: number}} Region
 *
 * @typedef {object} Regions
 * @property {Region[]} delimiters The braces, and a substitution's arrow.
 * @property {Region[]} inserted Text that appears if the suggestion is taken.
 * @property {Region[]} deleted Text that goes if it is taken.
 * @property {Region[]} highlighted A passage a remark is anchored to.
 * @property {Region[]} notes A remark's body.
 * @property {Region[]} replies A remark that answers the one before it.
 */

function region(start, end) {
  return { start, end };
}

function open(span) {
  return region(span.start, span.start + DELIMITER);
}

function close(span) {
  return region(span.end - DELIMITER, span.end);
}

function body(span) {
  return region(span.start + DELIMITER, span.end - DELIMITER);
}

/**
 * The regions to decorate in `source`, grouped by how each should look.
 *
 * @param {string} source
 * @returns {Regions}
 */
function decorationRegions(source) {
  const out = {
    delimiters: [],
    inserted: [],
    deleted: [],
    highlighted: [],
    notes: [],
    replies: [],
  };
  const spans = scan(source);
  const replies = new Set(threads(spans).flatMap((thread) => thread.comments.slice(1)));
  for (const span of spans) {
    out.delimiters.push(open(span), close(span));
    if (span.kind === "insertion") out.inserted.push(body(span));
    if (span.kind === "deletion") out.deleted.push(body(span));
    if (span.kind === "highlight") out.highlighted.push(body(span));
    if (span.kind === "comment") (replies.has(span) ? out.replies : out.notes).push(body(span));
    if (span.kind === "substitution") substitution(span, out);
  }
  return out;
}

function substitution(span, out) {
  const oldFrom = span.start + DELIMITER;
  const oldTo = oldFrom + span.before.length;
  out.deleted.push(region(oldFrom, oldTo));
  out.delimiters.push(region(oldTo, oldTo + ARROW));
  out.inserted.push(region(oldTo + ARROW, span.end - DELIMITER));
}

module.exports = { decorationRegions };
