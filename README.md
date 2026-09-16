# CriticMarkup Diff

[CriticMarkup](http://criticmarkup.com) is the plain-text vocabulary for tracked changes in
markdown — `{++inserted++}`, `{--deleted--}`, `{~~old~>new~~}`, `{==highlight==}`,
`{>>remark<<}`. Editors normally show it one of two ways: raw, or tinted by a grammar whose
scopes no theme has heard of. Neither tells you what a reviewer needs to know, which is what the
document says now and what it would say if you said yes.

So this extension renders it the way the tool that already answers that question renders it. A
marked-up document is a diff: reject every suggestion and you have the prose as it stands,
accept every one and you have the prose as proposed. The rendering is literally
`diff(reject_all, accept_all)`, laid out the way `git diff -U3` lays it out — and checked
against real `git diff`, hunk for hunk, in the test suite.

## The three surfaces

- **A live `.diff` document** (`CriticMarkup: Compare As Diff`, or the ⟚ button in the
  editor title bar). Opens beside the source, highlighted by VS Code's own `diff` grammar,
  re-rendered as you type. `@@` headers carry the enclosing markdown heading, three lines of
  context, `\ No newline at end of file` where it belongs. Strip the `#` review notes and it is
  a patch `git apply` takes.
- **The Markdown preview.** A change inside one line reads like `git diff --word-diff`: old
  words struck through in red, new words in green, in place, so the sentence still reads as a
  sentence. A change that crosses a line break reads like `git diff` proper — `@@ suggestion @@`
  over `-` and `+` rows — because once a suggestion rewrites whole lines, reading it inline
  means reading two interleaved versions of a paragraph.
- **The markdown source itself**, decorated: the old side on the theme's removed-text red, the
  new side on its inserted-text green, delimiters dimmed, suggestions marked in the overview
  ruler so you can see where they are in a long file. Nothing here is struck through — the
  markers are in the text in front of you, so the background is signal enough.

`CriticMarkup: Next Suggestion` / `Previous Suggestion` step through the review points — one per
suggestion, one per comment thread.

## Deciding, from the hover

Hover a suggestion and you get **Accept · Reject**, on one line and nothing else. A comment
thread offers **Resolve**: no edit was proposed, so there is nothing to accept; the markers go
and the passage they were about stays. The same three are in the command palette, acting at the
cursor.

The hover deliberately does not preview the change or repeat the reason. Both are already on
screen — the marker is decorated in place and its note renders beside it — and a popover big
enough to hold them covers the sentence you are reading it against.

**In bulk, the way the merge-conflict editor does it** — same command shape, same names, so the
tool you already use for this kind of decision reads the same here:

| CriticMarkup                                        | the built-in it mirrors                      |
| --------------------------------------------------- | -------------------------------------------- |
| `Accept Suggestion` / `Reject Suggestion`           | `Accept Current` / `Accept Incoming`         |
| `Accept Selection` / `Reject Selection`             | `Accept Selection`                           |
| `Accept All Suggestions` / `Reject All Suggestions` | `Accept All Current` / `Accept All Incoming` |
| `Resolve Comment` / `Resolve Selection`             | — no counterpart, a remark is not a conflict |
| `Next Suggestion` / `Previous Suggestion`           | `Next Conflict` / `Previous Conflict`        |
| `Compare As Diff`                                   | `Compare Current Conflict`                   |

Each of them is one `edit`, so settling thirty suggestions is one undo, not thirty.

A selection that only clips a marker still settles the whole of it: half a marker is not a
decision, and splicing one would leave the other half behind as broken markup. Comment threads
are never swept up by a bulk accept or reject — a remark proposed no edit, so there is nothing
in it to accept, and deleting the reviewer's notes as a side effect of taking their suggestions
is not a decision anyone asked for. Threads resolve on their own, at the cursor or across a
selection.

Every action is a normal editor edit, so <kbd>ctrl</kbd>+<kbd>z</kbd> puts it back.

**The unit of review is the decision, not the marker.** `{~~old~>new~~}{>>why<<}` — a suggestion
and the reason for it, which is what `lab.utils.criticmarkup.suggestion` emits and what the
notes site writes back — settles as one thing: accept the edit and the note goes with it.
Leaving it behind would turn one decision into two chores, and the second one has nothing left
to decide. A thread that anchors to a passage of its own (`{==quote==}{>>remark<<}`) is separate,
because it is a separate question.

Two guards, because a suggestion is untrusted input: the hover markdown trusts only this
extension's own three commands, so a document cannot plant a link to any other command, and no
text the document supplied is rendered in it at all — nothing to escape, because nothing from
the document gets in. The offset in a hover link is re-scanned when it is clicked rather than
trusted — by then the text may have moved, and splicing at a stale offset would corrupt prose
rather than fail.

## What "correctly" is doing in the sentence

Five things the obvious rendering gets wrong:

- **A remark is not an insertion.** `{>>tighten this<<}` and `{==passage==}` leave the text
  identical under both readings — they are review annotations, not edits. Rendering them as `+`
  lines would claim the reviewer proposed their own comment as prose; dropping them would lose
  half of what there is to answer. They render as notes hanging off their context line, the way
  a review comment hangs off a line in a pull request, and a thread of adjacent remarks
  (`{==quote==}{>>remark<<}{>>reply<<}`) renders as one thread.
- **A marker is a character range; a diff is about lines.** A whole-paragraph insertion written
  at the end of a line starts on a line it never alters. Reporting that line as `-` and `+`
  would claim a rewrite git does not see, so blocks are trimmed to the lines that actually
  differ — which is how a pure insertion comes out as `+` lines with no `-` line at all.
- **Two suggestions on one line are one hunk line.** They collapse into a single `-`/`+` pair,
  and suggestions on adjacent lines into one group with no context between them, because that is
  what a diff of the two resolved documents looks like.
- **Markup inside a code fence is a quoted sample.** A methods appendix showing the syntax is not
  a suggestion, and neither the preview nor the diff resolves it. (Same for `` `{++inline++}` ``
  code spans in the preview.)
- **A substitution's tildes are not a strikethrough.** `{~~old~>new~~}` is, to markdown, a
  perfectly ordinary `~~…~~` run, so the theme strikes the whole marker through — new side
  included, which reads as "delete this" about the text the suggestion is asking _for_. An
  injection grammar claims the two delimiters before markdown's inline rules run, and claims
  nothing else, so a real `~~strikethrough~~` — in a marker body or in the prose around it —
  is still the author's.

Two things it refuses to guess at: a marker left unterminated is not a suggestion (but the file
still counts as carrying markup), and a marker nested inside another — which no single pass can
resolve — is reported in the diff header rather than quietly half-resolved.

## Why decorations rather than a TextMate grammar

A grammar can only name scopes, and a scope like `criticmarkup.addition` is one no theme styles,
so the markup comes out unstyled almost everywhere — which is the state this extension was
written to replace. Decorations can reach for `diffEditor.insertedTextBackground` and
`diffEditor.removedTextBackground`: whatever red and green the running theme uses for a diff,
light or dark, is what a suggestion looks like. Colour is never the only signal: in the source
the markers themselves are still on screen (`{~~`, `~>`, `~~}`, dimmed), and the preview prefixes
`+`, `−`, `💬` and `↳`. The source view does not strike the old side through — one line over a
passage the red already speaks for — while the preview and the `.diff` keep the word-diff
strikethrough, having no markers of their own to read.

Delimiters are dimmed, not hidden. Hiding them (the `display: none` decoration trick) reads well
until you edit the line: the cursor walks through characters that are not there, and a
half-typed marker vanishes mid-keystroke.

There is one grammar, and it styles nothing. Markdown's own strikethrough rule matches
`{~~old~>new~~}` end to end, so without it the theme strikes the marker through and the new side
arrives looking deleted. `syntaxes/substitution-tildes.injection.json` is a left-injection that
claims the six characters of `{~~` and `~~}` — and only those, and never inside code — so the
rule has nothing to pair. `~>` needs no pattern: one tilde cannot open a strikethrough.

It injects into the three contexts that carry inline markdown — `meta.paragraph.markdown`,
`markup.heading`, `markup.table` — and pointedly not into the document root. A root injection
wins the race to column 0 against markdown's paragraph rule, so a line that _opens_ with a
marker never becomes a paragraph and silently loses bold, code spans and every other inline
rule. Naming the contexts lets the block rules run first and has us consulted inside them, where
a marker actually sits.

## Install

```sh
cd vscode-criticmarkup && npx --yes @vscode/vsce package
code --install-extension criticmarkup-*.vsix
```

Or, for a working copy VS Code picks up on reload, symlink the checkout into
`~/.vscode-server/extensions/` (remote) or `~/.vscode/extensions/` (local) and run
`Developer: Reload Window`.

## Development

Everything that reads markup lives in `lib/`, is pure, and is tested without VS Code:

| file                                          | what it owns                                                         |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `lib/criticmarkup.js`                         | the scanner, the two readings, comment threads, fenced-code skipping |
| `lib/unified.js`                              | hunk geometry and the `.diff` rendering                              |
| `lib/preview.js`                              | the markdown-it plugin behind the preview                            |
| `lib/decorations.js`                          | which source ranges get painted how                                  |
| `lib/review.js`                               | what one hover covers, what it offers, and the edit each offer makes |
| `syntaxes/substitution-tildes.injection.json` | keeping markdown's strikethrough off `{~~…~~}`                       |

```sh
npm test    # node --test, no dependencies, no VS Code
```

The suite is in two halves. `test/git-parity.test.js` resolves fixtures both ways, hands the two
versions to real `git diff -U3`, and requires our hunks back identical — same arithmetic, same
grouping, same context, same heading trailer — plus a `git apply` round trip proving the
rendering turns the rejected reading into the accepted one. `test/unified.test.js` covers what
annotations add on top, which is precisely what git cannot see.

The one thing `npm test` cannot check is the grammar, because tokenizing needs oniguruma and
this extension carries no dependencies. `test/grammar.test.js` reasons about markdown's
strikethrough rule as a regex; `tools/scope-check.js` runs the real tokenizer against VS Code's
real markdown grammar, from a scratch directory, and is worth running for any change to the
injection — it is what caught v0.3.0 injecting at the document root:

```sh
mkdir -p /tmp/scope-check && cd /tmp/scope-check
npm install vscode-textmate vscode-oniguruma
curl -sLo md.json https://raw.githubusercontent.com/microsoft/vscode/main/extensions/markdown-basics/syntaxes/markdown.tmLanguage.json
NODE_PATH=$PWD/node_modules node <checkout>/tools/scope-check.js md.json [file.md]
```

CommonJS, no build step, no runtime dependencies: the VS Code extension host loads CommonJS, and
a renderer this size does not need a bundler between the source and the thing that runs.

## Licence

MIT.
