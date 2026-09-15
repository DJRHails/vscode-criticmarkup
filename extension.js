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
 * Everything that reads markup lives in lib/, is pure, and is tested without VS Code.
 */

const vscode = require("vscode");

const { hasMarkup, isChange, scan, threads } = require("./lib/criticmarkup");
const { decorationRegions } = require("./lib/decorations");
const { criticMarkupPlugin } = require("./lib/preview");
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
 */
function buildTypes() {
  const ruler = vscode.OverviewRulerLane.Right;
  const create = (options) =>
    vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      ...options,
    });
  return {
    delimiters: create({ opacity: "0.45", color: themed("descriptionForeground") }),
    inserted: create({
      backgroundColor: themed("diffEditor.insertedTextBackground"),
      overviewRulerColor: themed("editorOverviewRuler.addedForeground"),
      overviewRulerLane: ruler,
    }),
    deleted: create({
      backgroundColor: themed("diffEditor.removedTextBackground"),
      textDecoration: "line-through",
      overviewRulerColor: themed("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: ruler,
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
