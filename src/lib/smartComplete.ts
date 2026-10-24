// CodeMirror glue for the SQL predictor: gray inline suggestions (Tab accepts)
// and context-aware completions in the popup.

import { acceptCompletion, completionStatus, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { keywordCompletionSource, type SQLDialect } from "@codemirror/lang-sql";
import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { TableInfo } from "../types";
import { predict, type Prediction, type Suggestion } from "./predict";
import { expandSnippet, snippetOptions } from "./snippets";
import { splitStatements } from "./sql";

/** Statement around the cursor: the text before it, and the whole statement. */
function statementAt(state: EditorState): { before: string; whole: string } {
  const text = state.doc.toString();
  const pos = state.selection.main.head;
  let start = 0;
  let end = text.length;
  for (const s of splitStatements(text)) {
    if (s.to < pos) start = s.to + 1;
    else if (s.from <= pos || s.to >= pos) {
      end = Math.max(pos, s.to);
      break;
    }
  }
  return { before: text.slice(start, pos), whole: text.slice(start, end) };
}

function predictionAt(state: EditorState, schema: TableInfo[]): Prediction {
  const { before, whole } = statementAt(state);
  return predict(before, whole, schema);
}

/** Only the word being typed precedes the cursor in its statement: a statement snippet fits. */
const atStatementStart = (state: EditorState) => !statementAt(state).before.replace(/\w+$/, "").trim();

/** Keywords and table names get a trailing space so the next guess can follow. */
function insertText(s: Suggestion): string {
  if (/[ ('.]$/.test(s.text)) return s.text;
  return s.type === "keyword" || s.type === "table" || s.type === "join" ? s.text + " " : s.text;
}

interface Ghost {
  /** Position where the typed prefix starts. */
  from: number;
  /** Text that replaces the prefix when accepted. */
  insert: string;
  /** Gray text shown after the cursor. */
  shown: string;
}

const setGhost = StateEffect.define<Ghost | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: GhostWidget) {
    return o.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost";
    span.textContent = this.text;
    return span;
  }
}

export function smartComplete(getSchema: () => TableInfo[]): Extension {
  const ghostField = StateField.define<Ghost | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setGhost)) return e.value;
      if (tr.docChanged || tr.selection) return null;
      return value;
    },
  });

  /** After typing, guess the continuation. Only at the end of a line or before a closing character. */
  const computeGhost = ViewPlugin.fromClass(
    class {
      update(u: ViewUpdate) {
        if (!u.docChanged || !u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete"))) return;
        const state = u.state;
        const sel = state.selection.main;
        if (!sel.empty) return;
        const next = state.doc.sliceString(sel.head, sel.head + 1);
        if (next && !/[\s);,]/.test(next)) return;
        const typed = u.transactions.some((t) => t.isUserEvent("input"));
        if (!typed) return;
        const pr = predictionAt(state, getSchema());
        const best = pr.suggestions[0];
        if (!best) return;
        const insert = insertText(best);
        if (pr.prefix && !insert.toLowerCase().startsWith(pr.prefix.toLowerCase())) return;
        const ghost: Ghost = { from: sel.head - pr.prefix.length, insert, shown: insert.slice(pr.prefix.length) };
        if (!ghost.shown.trim()) return;
        queueMicrotask(() => u.view.dispatch({ effects: setGhost.of(ghost) }));
      }
    },
  );

  const ghostDecorations = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      update(u: ViewUpdate) {
        const g = u.state.field(ghostField);
        const popupOpen = completionStatus(u.state) === "active";
        this.decorations =
          g && !popupOpen
            ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g.shown), side: 1 }).range(u.state.selection.main.head)])
            : Decoration.none;
      }
    },
    { decorations: (v) => v.decorations },
  );

  const acceptGhost = (view: EditorView): boolean => {
    if (completionStatus(view.state) === "active") return acceptCompletion(view);
    // Typed faster than the popup opens: a snippet's name still expands.
    if (expandSnippet(view, atStatementStart(view.state))) return true;
    const g = view.state.field(ghostField);
    if (!g) return false;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: g.from, to: pos, insert: g.insert },
      selection: { anchor: g.from + g.insert.length },
      userEvent: "input.complete",
    });
    return true;
  };

  return [
    ghostField,
    computeGhost,
    ghostDecorations,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: acceptGhost },
        { key: "ArrowRight", run: (v) => (v.state.field(ghostField) ? acceptGhost(v) : false) },
        { key: "Escape", run: (v) => (v.state.field(ghostField) ? (v.dispatch({ effects: setGhost.of(null) }), true) : false) },
      ]),
    ),
    EditorView.baseTheme({ ".cm-ghost": { color: "#A1A1A8", pointerEvents: "none" } }),
  ];
}

/** Popup completions: what fits here first, then plain SQL keywords. */
export function smartSource(getSchema: () => TableInfo[], dialect: () => SQLDialect): CompletionSource {
  return async (ctx) => {
    const pr = predictionAt(ctx.state, getSchema());
    if (!pr.prefix && !ctx.explicit) return null;
    const from = ctx.pos - pr.prefix.length;
    const options: Completion[] = pr.suggestions.slice(0, 60).map((s, i) => ({
      label: s.text,
      type: s.type === "table" ? "class" : s.type === "column" ? "property" : s.type === "keyword" ? "keyword" : "text",
      detail: s.detail,
      apply: insertText(s),
      boost: 99 - Math.min(i, 99),
    }));
    if (pr.prefix && !pr.prefix.includes(".")) {
      options.push(...snippetOptions(atStatementStart(ctx.state)));
      const kw = await keywordCompletionSource(dialect(), true)(ctx);
      if (kw && kw.from === from) {
        const have = new Set(options.map((o) => o.label.toLowerCase()));
        for (const o of kw.options) if (!have.has(o.label.toLowerCase())) options.push({ ...o, boost: -10 });
      }
    }
    return options.length ? { from, options, validFor: /^[\w$.]*$/ } : null;
  };
}
