"use strict";

/**
 * CriticMarkup rendered as a unified diff, on three surfaces:
 *
 * - the markdown source, decorated in the theme's own diff colours (lib/decorations.js);
 * - the built-in Markdown preview, word-diff inline and hunks for line-crossing edits
 *   (lib/preview.js);
 * - a read-only `.diff` document, which is the rendering git itself would print
 *   (lib/unified.js), opened beside the source and kept live as you type.
 *
 * Hovering a suggestion on any of them offers the decision itself — Accept, Reject, Resolve
 * (lib/review.js) — as command links in the hover.
 *
 * Everything that reads markup lives in lib/, is pure, and is tested without VS Code.
 */

const vscode = require("vscode");

const { hasMarkup, isChange, scan, threads } = require("./lib/criticmarkup");
const { decorationRegions } = require("./lib/decorations");
const { criticMarkupPlugin } = require("./lib/preview");
const { ACTIONS, editFor, editsIn, hoverModel, unitAt } = require("./lib/review");
const { renderUnifiedDiff } = require("./lib/unified");

/** Scheme of the read-only unified-diff documents. */
const SCHEME = "criticmarkup-diff";

/** Coalesce repaints while typing; a keystroke rescans the document. */
const REDRAW_MS = 120;

const NO_REGIONS = {
  delimiters: [],
  inserted: [],
  deleted: [],
  highlighted: [],
  notes: [],
  replies: [],
};

function themed(id) {
  return new vscode.ThemeColor(id);
}

/**
 * One decoration type per region kind, every colour taken from the theme's diff palette so the
 * source view and the diff editor agree about what red and green mean.
 *
 * Nothing in the source view is struck through — the background carries the reading on its own,
 * and the markers are right there in the text, so no signal rests on colour alone. Striking the
 * old side as well only added a second line to a passage the red already spoke for (maintainer
 * call, 2026-09-16). The `.diff` document and the preview keep their word-diff strikethrough,
 * where there is no marker to read and `-` needs to look removed.
 *
 * So every type that can land on a marker says `text-decoration: none !important` out loud. The
 * grammar takes a substitution's tildes away from markdown's strikethrough rule, but a grammar
 * is registered by the window and a decoration by the extension host, so on the
 * install-then-restart-the-host path the rule can still be in force when this paint happens —
 * and a struck-through *green* reads as "delete this" about the text the suggestion is asking
 * for.
 *
 * `!important` is load-bearing, not superstition. A decoration's rule and the token's
 * strikethrough class land on the same span at the same specificity, and the token rule was
 * seen winning the tie: plain `none` shipped in 0.3.2 and changed nothing on screen.
 */
function buildTypes() {
  const ruler = vscode.OverviewRulerLane.Right;
  const create = (options) =>
    vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      ...options,
    });
  return {
    delimiters: create({
      opacity: "0.45",
      color: themed("descriptionForeground"),
      textDecoration: "none !important",
    }),
    inserted: create({
      backgroundColor: themed("diffEditor.insertedTextBackground"),
      overviewRulerColor: themed("editorOverviewRuler.addedForeground"),
      overviewRulerLane: ruler,
      textDecoration: "none !important",
    }),
    deleted: create({
      backgroundColor: themed("diffEditor.removedTextBackground"),
      overviewRulerColor: themed("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: ruler,
      textDecoration: "none !important",
    }),
    highlighted: create({ backgroundColor: themed("editor.findMatchHighlightBackground") }),
    notes: create({
      color: themed("editorCodeLens.foreground"),
      fontStyle: "italic",
      overviewRulerColor: themed("editorOverviewRuler.infoForeground"),
      overviewRulerLane: ruler,
    }),
    replies: create({ color: themed("editorCodeLens.foreground"), fontStyle: "italic" }),
  };
}

function paint(editor, types) {
  if (!editor || editor.document.languageId !== "markdown") return;
  const source = editor.document.getText();
  const regions = hasMarkup(source) ? decorationRegions(source) : NO_REGIONS;
  for (const [kind, type] of Object.entries(types)) {
    const ranges = (regions[kind] ?? []).map(
      (at) =>
        new vscode.Range(editor.document.positionAt(at.start), editor.document.positionAt(at.end)),
    );
    editor.setDecorations(type, ranges);
  }
}

/** The diff document standing for `source`; the query carries the document it renders. */
function diffUri(source) {
  const name = source.path.split("/").pop();
  return vscode.Uri.from({ scheme: SCHEME, path: `/${name}.diff`, query: source.toString() });
}

class UnifiedDiffProvider {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
  }

  async provideTextDocumentContent(uri) {
    const source = vscode.Uri.parse(uri.query);
    const document = await vscode.workspace.openTextDocument(source);
    const path = vscode.workspace.asRelativePath(source, false);
    return renderUnifiedDiff(document.getText(), { path });
  }

  /** Re-render the diff of `source`, if one is open. */
  refresh(source) {
    this.changed.fire(diffUri(source));
  }
}

async function openUnifiedDiff() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown") {
    vscode.window.showInformationMessage("CriticMarkup: open a markdown document first.");
    return;
  }
  const document = await vscode.workspace.openTextDocument(diffUri(editor.document.uri));
  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
    preserveFocus: true,
  });
}

/** Offsets worth stopping at: one per suggestion, one per comment thread. */
function reviewPoints(source) {
  const spans = scan(source);
  const points = spans.filter(isChange).map((span) => span.start);
  return points.concat(threads(spans).map((thread) => thread.start)).sort((a, b) => a - b);
}

function jump(forwards) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const points = reviewPoints(editor.document.getText());
  const at = editor.document.offsetAt(editor.selection.active);
  const target = forwards
    ? points.find((point) => point > at)
    : points.reverse().find((point) => point < at);
  if (target === undefined) {
    vscode.window.setStatusBarMessage("CriticMarkup: no further suggestion", 2000);
    return;
  }
  const position = editor.document.positionAt(target);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );
}

/** A `command:` link the hover can offer, carrying the offset of the unit it acts on. */
function actionLink(action) {
  const args = encodeURIComponent(JSON.stringify([action.offset]));
  return `[${action.label}](command:${action.command}?${args})`;
}

/**
 * The hover over a suggestion: the decision, on one line.
 *
 * Only this extension's own commands are trusted in the markdown, and no text the document
 * supplied is rendered here at all — a suggestion is untrusted input, and a trusted hover that
 * rendered it raw would let a document plant a link to any command.
 */
function provideHover(document, position) {
  const source = document.getText();
  const unit = unitAt(source, document.offsetAt(position));
  if (!unit) return null;
  const model = hoverModel(unit);
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = { enabledCommands: Object.values(ACTIONS).map((a) => a.command) };
  markdown.appendMarkdown(model.actions.map(actionLink).join(" · "));
  return new vscode.Hover(
    markdown,
    new vscode.Range(document.positionAt(model.range.start), document.positionAt(model.range.end)),
  );
}

/** The offset range a selection covers; an empty selection is the cursor. */
function offsets(document, selection) {
  return { start: document.offsetAt(selection.start), end: document.offsetAt(selection.end) };
}

/**
 * The splices a command makes: one unit at `offset` for a hover link, else every unit the
 * selections touch — which for a bare cursor is the one unit it sits in.
 *
 * Two cursors inside one unit would otherwise each ask for the same splice, and a second
 * replace over the same range is an error rather than a no-op, so they are settled by start.
 */
function splicesFor(document, action, offset) {
  const source = document.getText();
  if (offset !== undefined) {
    const unit = unitAt(source, offset);
    const edit = unit && editFor(source, unit, action);
    return edit ? [edit] : [];
  }
  const found = new Map();
  for (const selection of vscode.window.activeTextEditor.selections) {
    for (const edit of editsIn(source, offsets(document, selection), action)) {
      found.set(edit.start, edit);
    }
  }
  return [...found.values()];
}

/**
 * Take the decision at `offset`, or across the selection when invoked from the palette.
 *
 * The document is re-read and re-scanned here rather than trusting the hover that offered the
 * link: by the time it is clicked the text may have moved, and splicing at a stale offset would
 * corrupt the prose rather than fail. Every splice goes into one `edit`, so a bulk action is one
 * undo away from where it started.
 */
async function act(action, offset) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const edits = splicesFor(editor.document, action, offset);
  if (!edits.length) {
    vscode.window.setStatusBarMessage(`CriticMarkup: nothing to ${action} here`, 2000);
    return;
  }
  await apply(editor, edits);
}

/** Every splice in one edit, so a bulk action is one undo away from where it started. */
function apply(editor, edits) {
  return editor.edit((builder) => {
    for (const edit of edits) {
      const range = new vscode.Range(
        editor.document.positionAt(edit.start),
        editor.document.positionAt(edit.end),
      );
      builder.replace(range, edit.replacement);
    }
  });
}

/**
 * Settle every suggestion in the file at once.
 *
 * Comment threads are left where they are: a remark proposed no edit, so there is nothing in it
 * to accept or reject, and sweeping the reviewer's notes away as a side effect of taking their
 * suggestions is not a decision anyone asked for. They keep their own Resolve.
 */
async function actOnFile(action) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown") return;
  const source = editor.document.getText();
  const edits = editsIn(source, { start: 0, end: source.length }, action);
  if (!edits.length) {
    vscode.window.setStatusBarMessage(`CriticMarkup: no suggestion to ${action}`, 2000);
    return;
  }
  await apply(editor, edits);
  vscode.window.setStatusBarMessage(
    `CriticMarkup: ${action}ed ${edits.length} suggestion${edits.length === 1 ? "" : "s"}`,
    3000,
  );
}

function activate(context) {
  const types = buildTypes();
  const provider = new UnifiedDiffProvider();
  let timer;
  const repaint = () => paint(vscode.window.activeTextEditor, types);
  repaint();
  context.subscriptions.push(
    ...Object.values(types),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.commands.registerCommand("criticmarkup.openUnifiedDiff", openUnifiedDiff),
    vscode.commands.registerCommand("criticmarkup.nextSuggestion", () => jump(true)),
    vscode.commands.registerCommand("criticmarkup.previousSuggestion", () => jump(false)),
    vscode.commands.registerCommand(ACTIONS.accept.command, (at) => act("accept", at)),
    vscode.commands.registerCommand(ACTIONS.reject.command, (at) => act("reject", at)),
    vscode.commands.registerCommand(ACTIONS.resolve.command, (at) => act("resolve", at)),
    vscode.commands.registerCommand("criticmarkup.acceptAll", () => actOnFile("accept")),
    vscode.commands.registerCommand("criticmarkup.rejectAll", () => actOnFile("reject")),
    vscode.languages.registerHoverProvider({ language: "markdown" }, { provideHover }),
    vscode.window.onDidChangeActiveTextEditor(repaint),
    vscode.workspace.onDidChangeTextDocument((event) => {
      provider.refresh(event.document.uri);
      if (event.document !== vscode.window.activeTextEditor?.document) return;
      clearTimeout(timer);
      timer = setTimeout(repaint, REDRAW_MS);
    }),
    { dispose: () => clearTimeout(timer) },
  );
}

function deactivate() {}

/** VS Code's markdown preview loads this (contributes.markdown.markdownItPlugins). */
function extendMarkdownIt(md) {
  return criticMarkupPlugin(md);
}

module.exports = { activate, deactivate, extendMarkdownIt };
