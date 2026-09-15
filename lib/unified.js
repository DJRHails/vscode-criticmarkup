"use strict";

/**
 * Rendering CriticMarkup as a unified diff.
 *
 * A marked-up document is already a diff: rejecting every suggestion recovers the prose as it
 * stands, accepting every one gives the prose as proposed. So this is not an interpretation of
 * the markers — it is literally `diff(reject_all, accept_all)`, laid out the way `git diff -U3`
 * lays it out: `@@` hunk headers carrying the enclosing heading, three lines of context, `-` for
 * the old side, `+` for the new, `\ No newline at end of file` where it belongs.
 *
 * Two kinds of marker carry no text change and so produce no `-`/`+` line: a `{==highlight==}`
 * unwraps to the same text either way, and a `{>>remark<<}` disappears either way. They are
 * review annotations, not edits, and render as such — a `#` note hanging off the context line
 * they sit on, the way a review comment hangs off a line in a pull request. Dropping them would
 * lose half of what a reviewer has to answer; rendering them as `+` lines would claim a change
 * nobody suggested.
 *
 * Every body line is therefore a valid unified-diff line except those `#` notes: strip them and
 * what is left applies with `git apply`, which test/git-parity.test.js checks along with
 * hunk-for-hunk agreement against real `git diff`.
 */

const { isChange, nestedSpans, scan, threads } = require("./criticmarkup");

/** Lines of context either side of a change, as `git diff` defaults to. */
const CONTEXT = 3;

/** A markdown heading — the `@@ … @@` trailer, where git puts the enclosing function. */
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;

/**
 * One side of the diff: its lines, whether the last one was newline-terminated, and a lookup
 * from a character offset to the line holding it.
 *
 * @param {string} text
 */
function side(text) {
  const list = text.split("\n");
  const endsWithEol = list.length > 1 && list[list.length - 1] === "";
  if (endsWithEol) list.pop();
  const starts = [];
  let at = 0;
  for (const line of list) {
    starts.push(at);
    at += line.length + 1;
  }
  return {
    list,
    endsWithEol,
    lineAt(offset) {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (starts[mid] <= offset) low = mid;
        else high = mid - 1;
      }
      return Math.max(low, 0);
    },
  };
}

/**
 * Resolve the document both ways at once, keeping every marker's offsets on both sides.
 *
 * Resolving twice independently would leave nothing tying a marker to the place it lands in
 * either reading, which is exactly what the hunk geometry is built from.
 *
 * @param {string} source
 */
function resolveWithMap(source) {
  const spans = scan(source);
  const oldParts = [];
  const newParts = [];
  const records = [];
  let oldLen = 0;
  let newLen = 0;
  let cursor = 0;
  for (const span of spans) {
    const between = source.slice(cursor, span.start);
    oldParts.push(between, span.rejected);
    newParts.push(between, span.accepted);
    oldLen += between.length;
    newLen += between.length;
    records.push({
      span,
      oldStart: oldLen,
      oldEnd: oldLen + span.rejected.length,
      newStart: newLen,
      newEnd: newLen + span.accepted.length,
    });
    oldLen += span.rejected.length;
    newLen += span.accepted.length;
    cursor = span.end;
  }
  const tail = source.slice(cursor);
  oldParts.push(tail);
  newParts.push(tail);
  return { spans, records, oldText: oldParts.join(""), newText: newParts.join("") };
}

/** The line range a record covers on one side; an empty side still sits on one line. */
function lineRange(from, to, at) {
  return [at.lineAt(from), at.lineAt(Math.max(to - 1, from))];
}

/**
 * Shrink a block off the lines it leaves untouched, so it covers only what actually differs.
 *
 * A marker sits at a character offset, so a whole-paragraph insertion written at the end of a
 * line starts on a line the change never alters. Reporting that line as `-` and `+` would claim
 * a rewrite git does not see — a line-based diff only ever names lines that differ. Trimming can
 * empty one side (a pure insertion or deletion of whole lines) and can empty both, which is a
 * marker pair whose two halves cancel out and belongs in no hunk at all.
 */
function trimUnchanged(block, oldSide, newSide) {
  const same = (oldLine, newLine) => oldSide.list[oldLine] === newSide.list[newLine];
  while (
    block.oldL0 <= block.oldL1 &&
    block.newL0 <= block.newL1 &&
    same(block.oldL0, block.newL0)
  ) {
    block.oldL0 += 1;
    block.newL0 += 1;
  }
  while (
    block.oldL0 <= block.oldL1 &&
    block.newL0 <= block.newL1 &&
    same(block.oldL1, block.newL1)
  ) {
    block.oldL1 -= 1;
    block.newL1 -= 1;
  }
  return block.oldL0 <= block.oldL1 || block.newL0 <= block.newL1;
}

/**
 * One `-`/`+` group per run of changes sharing a line or sitting on adjacent lines.
 *
 * Two suggestions on one source line must render as a single `-`/`+` pair, and two on
 * consecutive lines as one group with no context between them, because that is what a diff of
 * the two resolved documents looks like.
 */
function changeBlocks(records, oldSide, newSide) {
  const blocks = [];
  for (const record of records) {
    if (!isChange(record.span)) continue;
    const [oldL0, oldL1] = lineRange(record.oldStart, record.oldEnd, oldSide);
    const [newL0, newL1] = lineRange(record.newStart, record.newEnd, newSide);
    const last = blocks[blocks.length - 1];
    if (last && oldL0 <= last.oldL1 + 1 && newL0 <= last.newL1 + 1) {
      last.oldL1 = Math.max(last.oldL1, oldL1);
      last.newL1 = Math.max(last.newL1, newL1);
      continue;
    }
    blocks.push({ oldL0, oldL1, newL0, newL1, change: true });
  }
  return blocks.filter((block) => trimUnchanged(block, oldSide, newSide));
}

/** A remark as `#` lines — the first marked 💬, a reply ↳, continuation lines hanging. */
function note(text, isReply) {
  const [first, ...rest] = text.split("\n");
  const lead = isReply ? "↳" : "💬";
  return [`# ${lead} ${first}`.trimEnd(), ...rest.map((line) => `#   ${line}`.trimEnd())];
}

/**
 * One rendered note per comment thread, keyed by the old-side line it hangs off, plus the
 * anchors that keep a thread in unchanged prose from falling outside every hunk.
 */
function noteLines(spans, records) {
  const byLine = new Map();
  const anchors = [];
  const at = new Map(records.map((record) => [record.span, record]));
  for (const thread of threads(spans)) {
    const record = at.get(thread.comments[0]);
    const rendered = thread.comments.flatMap((comment, i) => note(comment.text, i > 0));
    byLine.set(record.line, (byLine.get(record.line) ?? []).concat(rendered));
    anchors.push({
      oldL0: record.line,
      oldL1: record.line,
      newL0: record.newLine,
      newL1: record.newLine,
    });
  }
  return { byLine, anchors };
}

/** Anchors close enough to share context lines belong to one hunk, as git groups them. */
function groupHunks(anchors, context) {
  const hunks = [];
  for (const anchor of anchors.slice().sort((a, b) => a.oldL0 - b.oldL0)) {
    const last = hunks[hunks.length - 1];
    if (last && anchor.oldL0 - last.oldL1 - 1 <= 2 * context) {
      last.anchors.push(anchor);
      last.oldL1 = Math.max(last.oldL1, anchor.oldL1);
      last.newL1 = Math.max(last.newL1, anchor.newL1);
      continue;
    }
    hunks.push({ ...anchor, anchors: [anchor] });
  }
  return hunks;
}

/**
 * The nearest heading strictly above `line`, for the `@@ … @@` trailer.
 *
 * Strictly above because git's function-context scan starts at the line before the hunk: when
 * the heading is itself the hunk's first context line, repeating it in the trailer is noise.
 */
function headingAbove(lines, line) {
  for (let i = Math.min(line - 1, lines.length - 1); i >= 0; i -= 1) {
    const match = HEADING.exec(lines[i]);
    if (match) return `${match[1]} ${match[2]}`;
  }
  return "";
}

function emit(rows, prefix, at, index) {
  rows.push(prefix + at.list[index]);
  if (index === at.list.length - 1 && !at.endsWithEol) rows.push("\\ No newline at end of file");
}

/** The body of one hunk: context lines, `-`/`+` groups, and the notes hanging off each line. */
function hunkBody(hunk, oldSide, newSide, notes) {
  const rows = [];
  const blocks = hunk.anchors.filter((anchor) => anchor.change);
  let oldLine = hunk.oldFrom;
  let next = 0;
  // The loop outlives the context window: a block that only adds lines consumes no old line, so
  // one sitting just past the last context line still has its `+` lines to emit.
  while (oldLine <= hunk.oldTo || next < blocks.length) {
    const block = blocks[next];
    if (block && block.oldL0 <= oldLine) {
      for (let i = block.oldL0; i <= block.oldL1; i += 1) emit(rows, "-", oldSide, i);
      for (let i = block.newL0; i <= block.newL1; i += 1) emit(rows, "+", newSide, i);
      for (let i = block.oldL0; i <= block.oldL1; i += 1) rows.push(...(notes.get(i) ?? []));
      oldLine = Math.max(oldLine, block.oldL1 + 1);
      next += 1;
      continue;
    }
    if (oldLine > hunk.oldTo) break;
    emit(rows, " ", oldSide, oldLine);
    rows.push(...(notes.get(oldLine) ?? []));
    oldLine += 1;
  }
  return rows;
}

/** `l,c` for one side of a hunk header, omitting the count when it is 1, as git does. */
function extent(start, count) {
  return count === 1 ? `${start + 1}` : `${start + 1},${count}`;
}

function laidOut(hunk, oldSide, newSide, notes, context) {
  const oldFrom = Math.max(hunk.oldL0 - context, 0);
  const newFrom = Math.max(hunk.newL0 - context, 0);
  const oldTo = Math.min(hunk.oldL1 + context, oldSide.list.length - 1);
  const newTo = Math.min(hunk.newL1 + context, newSide.list.length - 1);
  const placed = { ...hunk, oldFrom, oldTo, newFrom, newTo };
  const removed = extent(oldFrom, oldTo - oldFrom + 1);
  const added = extent(newFrom, newTo - newFrom + 1);
  const at = `@@ -${removed} +${added} @@`;
  const heading = headingAbove(oldSide.list, oldFrom);
  placed.header = heading ? `${at} ${heading}` : at;
  placed.rows = hunkBody(placed, oldSide, newSide, notes);
  return placed;
}

/**
 * The hunks of `source`, read as a diff from every-suggestion-rejected to every-one-taken.
 *
 * @param {string} source The document, CriticMarkup and all.
 * @param {{context?: number}} [options]
 */
function diffModel(source, options = {}) {
  const context = options.context ?? CONTEXT;
  const { spans, records, oldText, newText } = resolveWithMap(source);
  const oldSide = side(oldText);
  const newSide = side(newText);
  for (const record of records) {
    record.line = oldSide.lineAt(record.oldStart);
    record.newLine = newSide.lineAt(record.newStart);
  }
  const notes = noteLines(spans, records);
  const anchors = changeBlocks(records, oldSide, newSide).concat(notes.anchors);
  const hunks = groupHunks(anchors, context).map((hunk) =>
    laidOut(hunk, oldSide, newSide, notes.byLine, context),
  );
  return {
    oldText,
    newText,
    hunks,
    spans,
    records,
    changes: records.filter((record) => isChange(record.span)).length,
    threads: threads(spans).length,
  };
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * `source` rendered as a unified diff, ready to read in a `diff`-highlighted editor.
 *
 * @param {string} source The document, CriticMarkup and all.
 * @param {{path?: string, context?: number}} [options] `path` labels the a/ and b/ sides.
 * @returns {string} The diff, newline-terminated; just the `#` summary when nothing is suggested.
 */
function renderUnifiedDiff(source, options = {}) {
  const path = options.path ?? "document.md";
  const model = diffModel(source, options);
  const rows = [
    `# ${count(model.changes, "suggestion")}, ${count(model.threads, "comment thread")}`,
  ];
  for (const nested of nestedSpans(source)) {
    rows.push(`# ! nested marker at offset ${nested.start} — two deep, only one pass is shown`);
  }
  if (!model.hunks.length) return `${rows.join("\n")}\n`;
  rows.push(
    "# a/ = every suggestion rejected, b/ = every suggestion accepted",
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
  );
  for (const hunk of model.hunks) rows.push(hunk.header, ...hunk.rows);
  return `${rows.join("\n")}\n`;
}

module.exports = { CONTEXT, diffModel, renderUnifiedDiff, resolveWithMap };
