import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, selectAll, toggleComment } from "@codemirror/commands";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { format as formatSql } from "sql-formatter";
import { MySQL, PostgreSQL, sql } from "@codemirror/lang-sql";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  gutter,
  GutterMarker,
  crosshairCursor,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
  lineNumbers,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { copyText, pasteText } from "../lib/clipboard";
import { smartComplete, smartSource } from "../lib/smartComplete";
import { splitStatements, statementAt } from "../lib/sql";
import { openMenu } from "./ContextMenu";
import { useApp, type ConnTab, type DocTab } from "../store";
import type { TableInfo } from "../types";

type RunMode = "statement" | "all";
type Command = "find" | "format" | "comment";

/** The focused editor registers here so the toolbar and the menu bar can drive it. */
let activeRunner: ((mode: RunMode) => void) | null = null;
let activeCommand: ((cmd: Command) => void) | null = null;
export const runActive = (mode: RunMode) => activeRunner?.(mode);
export const editorCommand = (cmd: Command) => activeCommand?.(cmd);

/** Cursor and selection of the focused editor, for the toolbar and the status line. */
export const useEditorStatus = create<{ line: number; col: number; selected: number; statements: number }>(() => ({
  line: 1,
  col: 1,
  selected: 0,
  statements: 0,
}));

/** Underline where the server says the error is (Postgres reports a character position). */
const setErrorMark = StateEffect.define<{ from: number; to: number } | null>();
const errorMark = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    if (tr.docChanged) return Decoration.none;
    for (const e of tr.effects) {
      if (e.is(setErrorMark)) {
        marks = e.value && e.value.to > e.value.from
          ? Decoration.set([Decoration.mark({ class: "cm-error-mark" }).range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--syn-function)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: t.special(t.name), color: "var(--syn-param)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--bg-window)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "var(--editor-line-height)" },
  ".cm-content": { padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "var(--bg-window)", border: "none", color: "var(--label-quaternary)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 14px 0 4px", fontSize: "12px" },
  ".cm-active-stmt": { backgroundColor: "var(--editor-band)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--label-secondary)" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)", outline: "1px solid var(--warning)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--warning)" },
  ".cm-error-mark": { textDecoration: "underline wavy var(--error)", textUnderlineOffset: "3px" },
  ".cm-run-gutter": { width: "22px" },
  ".cm-run-marker": {
    width: "16px", height: "16px", marginTop: "3px", border: "none", borderRadius: "4px", padding: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "var(--accent-tint)", color: "var(--accent)", cursor: "pointer", fontSize: "8px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--label)" },
  ".cm-selectionBackground": { background: "var(--selection-inactive) !important" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { background: "var(--selection) !important" },
  // Find bar
  ".cm-panels": { backgroundColor: "var(--bg-inspector)", color: "var(--label)" },
  ".cm-panels-top": { borderBottom: ".5px solid var(--separator)" },
  ".cm-panel.cm-search": { padding: "6px 10px", fontFamily: "var(--font-ui)", fontSize: "12px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" },
  ".cm-panel.cm-search br": { display: "none" },
  ".cm-panel.cm-search input[type=text], .cm-textfield": {
    height: "24px", padding: "0 8px", border: "none", borderRadius: "6px", background: "var(--bg-field)", color: "var(--label)",
    fontFamily: "var(--font-mono)", fontSize: "12px", outline: "none", margin: 0,
  },
  ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--label-secondary)", margin: 0 },
  ".cm-button": {
    height: "24px", padding: "0 9px", border: "none", borderRadius: "6px", backgroundImage: "none",
    background: "var(--bg-control)", color: "var(--label)", boxShadow: "0 0 0 .5px var(--control-ring)", fontSize: "12px", margin: 0,
  },
  ".cm-panel.cm-search [name=close]": { position: "static", marginLeft: "auto", fontSize: "16px", color: "var(--label-secondary)", background: "none", border: "none" },
  ".cm-tooltip": { background: "var(--bg-card)", color: "var(--label)", border: "none" },
  ".cm-tooltip-autocomplete > ul > li": { color: "var(--label)" },
  ".cm-completionDetail": { color: "var(--label-tertiary)" },
  ".cm-matchingBracket": { background: "var(--accent-tint)", outline: "none" },
  ".cm-tooltip-autocomplete": { borderRadius: "9px", border: "none", boxShadow: "0 0 0 .5px rgba(0,0,0,.16), 0 12px 32px rgba(0,0,0,.18)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--accent)", color: "#fff" },
});

/** Tint the lines of the statement under the cursor. */
const activeStatement = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const b = new RangeSetBuilder<Decoration>();
      const text = view.state.doc.toString();
      const sel = view.state.selection.main;
      const s = sel.empty ? statementAt(text, sel.head) : null;
      if (s && text.trim()) {
        const first = view.state.doc.lineAt(s.from).number;
        const last = view.state.doc.lineAt(Math.min(s.to, text.length)).number;
        for (let n = first; n <= last; n++) {
          b.add(view.state.doc.line(n).from, view.state.doc.line(n).from, Decoration.line({ class: "cm-active-stmt" }));
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

class RunMarker extends GutterMarker {
  constructor(readonly from: number) {
    super();
  }
  eq(o: RunMarker) {
    return o.from === this.from;
  }
  toDOM() {
    const b = document.createElement("button");
    b.className = "cm-run-marker";
    b.setAttribute("aria-label", "Run this statement");
    b.textContent = "▶";
    return b;
  }
}

function runGutter(onRun: (from: number) => void) {
  return gutter({
    class: "cm-run-gutter",
    markers: (view) => {
      const b = new RangeSetBuilder<GutterMarker>();
      for (const s of splitStatements(view.state.doc.toString())) {
        const line = view.state.doc.lineAt(s.from);
        b.add(line.from, line.from, new RunMarker(s.from));
      }
      return b.finish();
    },
    domEventHandlers: {
      mousedown(view, block, event) {
        if (!(event.target as HTMLElement).classList.contains("cm-run-marker")) return false;
        const s = splitStatements(view.state.doc.toString()).find((x) => view.state.doc.lineAt(x.from).from === block.from);
        if (s) onRun(s.from);
        return true;
      },
    },
  });
}

const dialectOf = (engine: string) => (engine === "mysql" ? MySQL : PostgreSQL);

export function QueryEditor({ conn, doc }: { conn: ConnTab; doc: DocTab }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const schemaRef = useRef<TableInfo[]>(conn.schema ?? []);

  useEffect(() => {
    const { setSql, run } = useApp.getState();
    const runSql = (sqlText: string) => run(conn.id, doc.id, sqlText);
    const runner = (mode: RunMode) => {
      const v = view.current;
      if (!v) return;
      const text = v.state.doc.toString();
      const sel = v.state.selection.main;
      if (!sel.empty) return runSql(text.slice(sel.from, sel.to));
      if (mode === "all") return runSql(text);
      runSql(statementAt(text, sel.head)?.text ?? "");
    };
    const command = (cmd: Command) => {
      const v = view.current;
      if (!v) return;
      if (cmd === "find") openSearchPanel(v);
      else if (cmd === "comment") toggleComment(v);
      else formatIn(v, conn.profile.engine);
      v.focus();
    };
    const register = () => {
      activeRunner = runner;
      activeCommand = command;
    };
    const report = (st: EditorState) => {
      const sel = st.selection.main;
      const line = st.doc.lineAt(sel.head);
      useEditorStatus.setState({
        line: line.number,
        col: sel.head - line.from + 1,
        selected: sel.to - sel.from,
        statements: splitStatements(st.doc.toString()).length,
      });
    };

    const state = EditorState.create({
      doc: doc.sql,
      extensions: [
        lineNumbers(),
        runGutter((from) => {
          const s = statementAt(view.current!.state.doc.toString(), from);
          if (s) runSql(s.text);
        }),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        EditorState.phrases.of({
          Find: "Find",
          Replace: "Replace",
          next: "Next",
          previous: "Previous",
          all: "All",
          "match case": "Match case",
          regexp: "Regex",
          "by word": "Whole word",
          replace: "Replace",
          "replace all": "Replace All",
          close: "Close",
        }),
        errorMark,
        closeBrackets(),
        autocompletion({ icons: false, override: [smartSource(() => schemaRef.current, () => dialectOf(conn.profile.engine))] }),
        smartComplete(() => schemaRef.current),
        EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off", "data-gramm": "false" }),
        syntaxHighlighting(highlight),
        language.current.of(sql({ dialect: dialectOf(conn.profile.engine), upperCaseKeywords: true })),
        activeStatement,
        keymap.of([
          { key: "Mod-Enter", run: () => (runner("statement"), true) },
          { key: "Shift-Mod-Enter", run: () => (runner("all"), true) },
          { key: "Shift-Mod-f", run: () => (command("format"), true) },
          { key: "Mod-s", run: () => (useApp.getState().saveDoc(conn.id, doc.id), true) },
          { key: "Mod-/", run: toggleComment },
          ...searchKeymap,
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setSql(conn.id, doc.id, u.state.doc.toString());
          if (u.docChanged || u.selectionSet) report(u.state);
        }),
        EditorView.domEventHandlers({ focus: () => (register(), report(view.current!.state), false) }),
        theme,
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    register();
    report(v.state);
    v.focus();
    return () => {
      if (activeRunner === runner) activeRunner = null;
      if (activeCommand === command) activeCommand = null;
      v.destroy();
      view.current = null;
    };
    // Recreated per tab only; schema changes are applied below without losing undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, doc.id]);

  // Completions read the latest schema without rebuilding the editor (keeps undo history).
  useEffect(() => {
    schemaRef.current = conn.schema ?? [];
  }, [conn.schema]);

  // The tab's SQL can also change from outside (sorting a table tab adds ORDER BY): show it.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== doc.sql) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc.sql } });
    }
  }, [doc.sql]);

  // Point at the error position the server reported, when the failed SQL came from this editor.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const pos = doc.error?.db?.position;
    const sent = doc.lastRun;
    let mark: { from: number; to: number } | null = null;
    if (pos && sent) {
      const text = v.state.doc.toString();
      const start = text.indexOf(sent);
      if (start >= 0) {
        // Postgres counts characters from 1; JS strings index UTF-16 units.
        const from = start + [...sent].slice(0, pos - 1).join("").length;
        const word = /^[\w."]+/.exec(text.slice(from))?.[0].length ?? 1;
        mark = { from, to: Math.min(text.length, from + Math.max(1, word)) };
      }
    }
    v.dispatch({ effects: setErrorMark.of(mark) });
  }, [doc.error, doc.lastRun]);

  const onContextMenu = (e: React.MouseEvent) => {
    const v = view.current;
    if (!v) return;
    const sel = v.state.selection.main;
    const selected = v.state.sliceDoc(sel.from, sel.to);
    const replace = (text: string) => v.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, userEvent: "input.paste" });
    openMenu(e, [
      { label: selected ? "Run Selection" : "Run Statement", shortcut: "⌘↵", action: () => runActive("statement") },
      { label: "Run All", shortcut: "⇧⌘↵", action: () => runActive("all") },
      { label: "Save Query…", shortcut: "⌘S", action: () => useApp.getState().saveDoc(conn.id, doc.id) },
      "separator",
      { label: "Cut", shortcut: "⌘X", disabled: !selected, action: () => (copyText(selected), replace("")) },
      { label: "Copy", shortcut: "⌘C", disabled: !selected, action: () => copyText(selected) },
      { label: "Paste", shortcut: "⌘V", action: async () => replace(await pasteText()) },
      { label: "Select All", shortcut: "⌘A", action: () => selectAll(v) },
      "separator",
      { label: "Format SQL", shortcut: "⇧⌘F", action: () => formatIn(v, conn.profile.engine) },
      { label: "Toggle Comment", shortcut: "⌘/", action: () => toggleComment(v) },
    ]);
  };

  return (
    <div className="editor-frame">
      <div className="editor-host" ref={host} onContextMenu={onContextMenu} />
      <EditorStatus engine={conn.profile.engine} onSave={() => useApp.getState().saveDoc(conn.id, doc.id)} />
    </div>
  );
}

/** Format the selection, or the whole editor when nothing is selected. One undo step. */
function formatIn(v: EditorView, engine: string) {
  const sel = v.state.selection.main;
  const from = sel.empty ? 0 : sel.from;
  const to = sel.empty ? v.state.doc.length : sel.to;
  const src = v.state.sliceDoc(from, to);
  if (!src.trim()) return;
  try {
    const out = formatSql(src, {
      language: engine === "mysql" ? "mysql" : "postgresql",
      keywordCase: "upper",
      tabWidth: 2,
      linesBetweenQueries: 1,
    });
    v.dispatch({ changes: { from, to, insert: out }, userEvent: "input.format" });
  } catch (e) {
    useEditorStatus.setState({ selected: 0 });
    console.warn("format failed", e);
  }
}

function EditorStatus({ engine, onSave }: { engine: string; onSave: () => void }) {
  const { line, col, selected, statements } = useEditorStatus();
  return (
    <div className="editor-status">
      <button className="editor-status-btn" onClick={onSave} title="Save this query (⌘S)">
        Save
      </button>
      <button className="editor-status-btn" onClick={() => editorCommand("format")} title="Format SQL (⇧⌘F)">
        Format
      </button>
      <button className="editor-status-btn" onClick={() => editorCommand("find")} title="Find and replace (⌘F)">
        Find
      </button>
      <div className="grow" />
      {selected > 0 && <span>{selected.toLocaleString()} selected · ⌘↵ runs the selection</span>}
      <span>
        Ln {line}, Col {col}
      </span>
      <span>
        {statements} statement{statements === 1 ? "" : "s"}
      </span>
      <span>{engine === "mysql" ? "MySQL" : "PostgreSQL"}</span>
    </div>
  );
}
