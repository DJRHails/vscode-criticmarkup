"use strict";

/**
 * The extension host is not available here, so `vscode` is stubbed with the slice of the API
 * this extension uses. That does not prove the API calls are right — only VS Code can — but it
 * does exercise activation end to end: which commands register, which ranges get painted on
 * which decoration type, and what the diff document serves.
 */

const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

function fakeVscode() {
  const registered = { commands: new Map(), providers: new Map(), decorations: new Map() };
  const disposable = { dispose() {} };
  const position = (offset) => ({ offset });
  const api = {
    registered,
    ThemeColor: class ThemeColor {
      constructor(id) {
        this.id = id;
      }
    },
    Range: class Range {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    Selection: class Selection {
      constructor(anchor, active) {
        this.anchor = anchor;
        this.active = active;
      }
    },
    EventEmitter: class EventEmitter {
      constructor() {
        this.fired = [];
        this.event = () => disposable;
      }

      fire(value) {
        this.fired.push(value);
      }
    },
    Uri: {
      from: (parts) => ({
        ...parts,
        toString: () => `${parts.scheme}:${parts.path}?${parts.query}`,
      }),
      parse: (text) => ({ toString: () => text, path: text }),
    },
    Hover: class Hover {
      constructor(contents, range) {
        this.contents = contents;
        this.range = range;
      }
    },
    MarkdownString: class MarkdownString {
      constructor() {
        this.value = "";
      }

      appendMarkdown(text) {
        this.value += text;
      }

      appendCodeblock(text, language) {
        this.value += `\n\`\`\`${language}\n${text}\n\`\`\`\n`;
      }
    },
    languages: {
      registerHoverProvider: (selector, hoverProvider) => {
        registered.hover = hoverProvider;
        return disposable;
      },
    },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    OverviewRulerLane: { Right: 7 },
    ViewColumn: { Beside: -2 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    window: {
      activeTextEditor: undefined,
      createTextEditorDecorationType: (options) => ({ options, dispose() {} }),
      onDidChangeActiveTextEditor: () => disposable,
      showInformationMessage: () => {},
      setStatusBarMessage: () => {},
      showTextDocument: async () => {},
    },
    workspace: {
      registerTextDocumentContentProvider: (scheme, provider) => {
        registered.providers.set(scheme, provider);
        return disposable;
      },
      onDidChangeTextDocument: () => disposable,
      openTextDocument: async (uri) => api.documents.get(uri.toString()),
      asRelativePath: (uri) => uri.toString(),
    },
    commands: {
      registerCommand: (id, run) => {
        registered.commands.set(id, run);
        return disposable;
      },
    },
    documents: new Map(),
  };
  api.position = position;
  return api;
}

/** A document and an editor over `text`, with offsets standing in for positions. */
function openEditor(vscode, text, uri = "file:///doc.md") {
  const painted = new Map();
  const document = {
    uri: { toString: () => uri, path: "/doc.md" },
    languageId: "markdown",
    getText: () => text,
    positionAt: (offset) => ({ offset }),
    offsetAt: (place) => place.offset,
  };
  vscode.documents.set(uri, document);
  const applied = [];
  const editor = {
    document,
    selection: { active: { offset: 0 } },
    setDecorations: (type, ranges) => painted.set(type, ranges),
    revealRange: () => {},
    edit: async (build) => build({ replace: (range, text) => applied.push({ range, text }) }),
  };
  return { editor, painted, applied };
}

/** Load extension.js against the stub, fresh each time. */
function loadExtension(vscode) {
  const load = Module._load;
  Module._load = (request, ...rest) =>
    request === "vscode" ? vscode : load.call(Module, request, ...rest);
  try {
    delete require.cache[require.resolve("../extension.js")];
    return require("../extension.js");
  } finally {
    Module._load = load;
  }
}

function activated(text) {
  const vscode = fakeVscode();
  const { editor, painted, applied } = openEditor(vscode, text);
  vscode.window.activeTextEditor = editor;
  const extension = loadExtension(vscode);
  const context = { subscriptions: [] };
  extension.activate(context);
  return { vscode, extension, editor, painted, applied, context };
}

test("activation registers the commands, the diff provider, and disposes what it made", () => {
  const { vscode, context } = activated("plain prose\n");
  assert.deepEqual([...vscode.registered.commands.keys()].sort(), [
    "criticmarkup.accept",
    "criticmarkup.nextSuggestion",
    "criticmarkup.openUnifiedDiff",
    "criticmarkup.previousSuggestion",
    "criticmarkup.reject",
    "criticmarkup.resolve",
  ]);
  assert.ok(vscode.registered.providers.has("criticmarkup-diff"));
  assert.ok(context.subscriptions.length > 6);
});

test("the source is painted in the theme diff colours, old side struck through", () => {
  const source = "Fires on {~~12%~>11.4%~~}{>>recheck<<}.\n";
  const { painted } = activated(source);
  const under = (matches) => {
    const found = [...painted.entries()].find(([type]) => matches(type.options));
    return (found?.[1] ?? []).map((at) => source.slice(at.start.offset, at.end.offset));
  };
  const background = (id) => (options) => options.backgroundColor?.id === id;
  assert.deepEqual(
    under((o) => o.textDecoration === "line-through"),
    ["12%"],
  );
  assert.deepEqual(under(background("diffEditor.insertedTextBackground")), ["11.4%"]);
  assert.deepEqual(
    under((o) => o.fontStyle === "italic" && o.overviewRulerColor),
    ["recheck"],
  );
  assert.deepEqual(
    under((o) => o.opacity === "0.45"),
    ["{~~", "~~}", "~>", "{>>", "<<}"],
  );
});

test("a document with no markup clears every decoration instead of leaving stale paint", () => {
  const { painted } = activated("nothing to suggest here\n");
  assert.deepEqual([...painted.values()].flat(), []);
});

test("the diff document serves the rendering of the document it names", async () => {
  const { vscode } = activated("The corpus is {~~a month~>a year~~}.\n");
  const provider = vscode.registered.providers.get("criticmarkup-diff");
  const content = await provider.provideTextDocumentContent({ query: "file:///doc.md" });
  assert.ok(content.startsWith("# 1 suggestion, 0 comment threads\n"));
  assert.ok(content.includes("-The corpus is a month."));
  assert.ok(content.includes("+The corpus is a year."));
});

test("next and previous step through suggestions and threads, and stop at the ends", () => {
  const { vscode, editor } = activated("a {++one++} b {==c==}{>>note<<} d\n");
  const next = vscode.registered.commands.get("criticmarkup.nextSuggestion");
  next();
  assert.equal(editor.selection.active.offset, 2);
  next();
  assert.equal(editor.selection.active.offset, 14);
  next();
  assert.equal(editor.selection.active.offset, 14, "nothing further to jump to");
  vscode.registered.commands.get("criticmarkup.previousSuggestion")();
  assert.equal(editor.selection.active.offset, 2);
});

test("hovering a suggestion offers the decision as trusted command links", () => {
  const source = "Fires on {~~12%~>11.4%~~}{>>recompute<<} of traffic.\n";
  const { vscode } = activated(source);
  const hover = vscode.registered.hover.provideHover(vscode.window.activeTextEditor.document, {
    offset: source.indexOf("12%"),
  });
  const { value, isTrusted } = hover.contents;
  assert.deepEqual(isTrusted.enabledCommands, [
    "criticmarkup.accept",
    "criticmarkup.reject",
    "criticmarkup.resolve",
  ]);
  const start = source.indexOf("{~~");
  const end = source.indexOf("{>>recompute<<}") + "{>>recompute<<}".length;
  assert.ok(value.includes("**Substitution**"));
  assert.ok(value.includes("```diff\n-12%\n+11.4%\n```"));
  assert.ok(value.includes("> recompute"));
  assert.ok(value.includes(`[Accept](command:criticmarkup.accept?%5B${start}%5D)`));
  assert.ok(value.includes(`[Reject](command:criticmarkup.reject?%5B${start}%5D)`));
  assert.deepEqual([hover.range.start.offset, hover.range.end.offset], [start, end]);
});

test("hovering prose with nothing to decide offers nothing", () => {
  const { vscode } = activated("just prose\n");
  const document = vscode.window.activeTextEditor.document;
  assert.equal(vscode.registered.hover.provideHover(document, { offset: 3 }), null);
});

/** One applied edit as `[start, end, replacement]`, the shape a splice is read in. */
function splices(applied) {
  return applied.map((at) => [at.range.start.offset, at.range.end.offset, at.text]);
}

test("the accept command splices the whole unit away, leaving the new text", async () => {
  const source = "Fires on {~~12%~>11.4%~~}{>>recompute<<} of traffic.\n";
  const { vscode, applied } = activated(source);
  await vscode.registered.commands.get("criticmarkup.accept")(source.indexOf("{~~"));
  const end = source.indexOf("{>>recompute<<}") + "{>>recompute<<}".length;
  assert.deepEqual(splices(applied), [[source.indexOf("{~~"), end, "11.4%"]]);
});

test("an action invoked without an offset acts at the cursor", async () => {
  const source = "a {--gone--} b\n";
  const { vscode, editor, applied } = activated(source);
  editor.selection = { active: { offset: 5 } };
  await vscode.registered.commands.get("criticmarkup.reject")();
  assert.deepEqual(splices(applied), [[2, 12, "gone"]]);
});

test("an action on a stale offset changes nothing rather than splicing blind", async () => {
  const { vscode, applied } = activated("a {--gone--} b\n");
  await vscode.registered.commands.get("criticmarkup.accept")(0);
  await vscode.registered.commands.get("criticmarkup.resolve")(2);
  assert.deepEqual(applied, []);
});

test("the markdown preview plugin is exported for VS Code to pick up", () => {
  const { extension } = activated("");
  const calls = [];
  extension.extendMarkdownIt({ core: { ruler: { before: (...args) => calls.push(args) } } });
  assert.equal(calls[0][1], "criticmarkup");
});
