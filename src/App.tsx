import { useEffect } from "react";
import { ConfirmWrite } from "./components/ConfirmWrite";
import { ContextMenuHost } from "./components/ContextMenu";
import { EnvironmentsSheet } from "./components/EnvironmentsSheet";
import { ConnectionSheet } from "./components/ConnectionSheet";
import { ToastHost } from "./components/Toast";
import { Welcome } from "./components/Welcome";
import { Workspace } from "./components/Workspace";
import { onLinksPending, onMenu } from "./api";
import { editorCommand, runActive } from "./components/QueryEditor";
import { useResultsView } from "./components/Results";
import { useAppearance, type Appearance } from "./lib/theme";
import { useApp } from "./store";

export default function App() {
  const { showWelcome, conns, sheet, setSheet, loadProfiles, activeConn, newQuery, closeDoc, envSheet } = useApp();

  useEffect(() => {
    loadProfiles();
    useApp.getState().loadEnvironments();
  }, [loadProfiles]);

  // Connections handed over by other apps (oneclient://open?url=…, postgresql://…).
  useEffect(() => {
    const { receiveLinks } = useApp.getState();
    receiveLinks();
    let stop: (() => void) | undefined;
    onLinksPending(() => useApp.getState().receiveLinks()).then((f) => (stop = f));
    return () => stop?.();
  }, []);

  // Menu bar.
  useEffect(() => {
    let stop: (() => void) | undefined;
    onMenu((id) => {
      const st = useApp.getState();
      const c = st.conns.find((x) => x.id === st.activeConn);
      const d = c?.docs.find((x) => x.id === c.activeDoc);
      if (id.startsWith("appearance:")) return useAppearance.getState().set(id.slice(11) as Appearance);
      switch (id) {
        case "new-connection":
          return st.setSheet({ mode: "new" });
        case "new-query":
          return c && st.newQuery(c.id);
        case "close-tab":
          return c && st.closeDoc(c.id, c.activeDoc);
        case "next-tab":
          return c && st.cycleDoc(c.id, 1);
        case "prev-tab":
          return c && st.cycleDoc(c.id, -1);
        case "toggle-editor":
          return c && d && st.toggleEditor(c.id, d.id);
        case "refresh":
          return c && d && st.run(c.id, d.id, d.sql, d.kind === "table");
        case "run-statement":
        case "run-all":
          if (d?.showEditor) runActive(id === "run-all" ? "all" : "statement");
          else if (c && d) st.run(c.id, d.id, d.sql, d.kind === "table");
          return;
        case "find":
          // A table tab without its editor searches with its filter instead.
          if (d?.table && !d.showEditor) return document.querySelector<HTMLInputElement>(".filter-bar input:not(:disabled)")?.focus();
          return editorCommand("find");
        case "format":
          return editorCommand("format");
        case "comment":
          return editorCommand("comment");
        case "results-table":
          return useResultsView.getState().setView("table");
        case "results-json":
          return useResultsView.getState().setView("json");
      }
    }).then((f) => (stop = f));
    return () => stop?.();
  }, []);

  // App-wide shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const k = e.key.toLowerCase();
      // Tabs, like a browser: ⌘1…⌘8 pick a tab, ⌘9 the last, ⇧⌘] / ⇧⌘[ or ⌃Tab / ⌃⇧Tab step through.
      // `code` keeps these working on keyboard layouts where digits or brackets need Shift.
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      const step =
        (e.metaKey && e.shiftKey && e.code === "BracketRight") || (e.ctrlKey && !e.shiftKey && e.key === "Tab")
          ? 1
          : (e.metaKey && e.shiftKey && e.code === "BracketLeft") || (e.ctrlKey && e.shiftKey && e.key === "Tab")
            ? -1
            : 0;
      if (activeConn && digit && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useApp.getState().activateDocAt(activeConn, Number(digit));
      } else if (activeConn && step) {
        e.preventDefault();
        useApp.getState().cycleDoc(activeConn, step);
      } else if (k === "n") {
        e.preventDefault();
        setSheet({ mode: "new" });
      } else if (k === "t" && activeConn) {
        e.preventDefault();
        newQuery(activeConn);
      } else if ((k === "e" || k === "r") && activeConn && !e.shiftKey) {
        const st = useApp.getState();
        const c = st.conns.find((x) => x.id === activeConn);
        const d = c?.docs.find((x) => x.id === c.activeDoc);
        if (!c || !d) return;
        e.preventDefault();
        if (k === "e") st.toggleEditor(c.id, d.id);
        else st.run(c.id, d.id, d.sql, d.kind === "table");
      } else if (k === "w" && activeConn) {
        const c = useApp.getState().conns.find((x) => x.id === activeConn);
        if (c) {
          e.preventDefault();
          closeDoc(c.id, c.activeDoc);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeConn, newQuery, closeDoc, setSheet]);

  return (
    <>
      {showWelcome || conns.length === 0 ? <Welcome /> : <Workspace />}
      {sheet && <ConnectionSheet key={sheet.mode === "edit" ? sheet.profile.id : "new"} />}
      {envSheet && <EnvironmentsSheet />}
      <ConfirmWrite />
      <ContextMenuHost />
      <ToastHost />
    </>
  );
}
