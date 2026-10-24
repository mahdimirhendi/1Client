import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { copyText, pasteText } from "../lib/clipboard";
import { exact } from "../lib/input";

export type MenuItem =
  | { label: string; shortcut?: string; disabled?: boolean; checked?: boolean; action: () => void }
  | "separator";

interface MenuState {
  /** `search`: a filter field above the items, for long lists. */
  menu: { x: number; y: number; items: MenuItem[]; search?: boolean } | null;
  open(x: number, y: number, items: MenuItem[], search?: boolean): void;
  close(): void;
}

export const useMenu = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, items, search) => set({ menu: { x, y, items, search } }),
  close: () => set({ menu: null }),
}));

/** Open a short app menu instead of the long system one. */
export function openMenu(e: React.MouseEvent | MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  useMenu.getState().open(e.clientX, e.clientY, items);
}

/** A menu under a button, like a macOS pop-up button. `search` adds a filter field for long lists. */
export function openMenuBelow(el: HTMLElement, items: MenuItem[], search = false) {
  const r = el.getBoundingClientRect();
  useMenu.getState().open(r.left, r.bottom + 4, items, search);
}

/** Plain text fields get Cut / Copy / Paste / Select All, nothing else. */
function textFieldItems(el: HTMLInputElement | HTMLTextAreaElement): MenuItem[] {
  const sel = () => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  const replace = (text: string) => {
    el.focus();
    el.setRangeText(text, el.selectionStart ?? 0, el.selectionEnd ?? 0, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const hasSel = (el.selectionStart ?? 0) !== (el.selectionEnd ?? 0);
  const secret = el.type === "password";
  return [
    { label: "Cut", shortcut: "⌘X", disabled: !hasSel || secret || el.readOnly, action: () => (copyText(sel()), replace("")) },
    { label: "Copy", shortcut: "⌘C", disabled: !hasSel || secret, action: () => copyText(sel()) },
    { label: "Paste", shortcut: "⌘V", disabled: el.readOnly, action: async () => replace(await pasteText()) },
    "separator",
    { label: "Select All", shortcut: "⌘A", action: () => (el.focus(), el.select()) },
  ];
}

export function ContextMenuHost() {
  const { menu, close } = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [menu]);

  // Never show the system menu; text fields get a short one.
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) openMenu(e, textFieldItems(t));
    };
    window.addEventListener("contextmenu", onContext);
    return () => window.removeEventListener("contextmenu", onContext);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    };
  }, [menu, close]);

  // Keep the menu on screen.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 6),
      y: menu.y + r.height > window.innerHeight - 6 ? Math.max(6, menu.y - r.height) : menu.y,
    });
  }, [menu]);

  if (!menu) return null;
  const q = query.trim().toLowerCase();
  const items = q ? menu.items.filter((item) => item !== "separator" && item.label.toLowerCase().includes(q)) : menu.items;
  const pick = (item: MenuItem) => {
    if (item === "separator" || item.disabled) return;
    close();
    item.action();
  };
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {menu.search && (
        <input
          {...exact}
          className="ctx-search"
          aria-label="Filter"
          placeholder="Filter"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && items[0] && pick(items[0])}
        />
      )}
      {q && items.length === 0 && <div className="ctx-empty">No match</div>}
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className="ctx-item"
            disabled={item.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(item)}
          >
            <span>
              {item.checked !== undefined && <span className="ctx-check">{item.checked ? "✓" : ""}</span>}
              {item.label}
            </span>
            {item.shortcut && <span className="ctx-key">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
