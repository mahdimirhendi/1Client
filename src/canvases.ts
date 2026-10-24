import { create } from "zustand";
import { api } from "./api";
import {
  acknowledge,
  addNewTables,
  changesOf,
  duplicate,
  indexSchema,
  newCanvas,
  rescope,
  type CanvasSpec,
} from "./lib/diagram";
import { showToast } from "./lib/toast";
import type { ConnTab } from "./store";
import type { AppError, Canvas } from "./types";

/** Saved this long after the last change, so dragging and typing don't write on every step. */
const SAVE_DELAY = 300;

export interface SaveStatus {
  state: "saving" | "saved" | "failed";
  /** When it was last saved, in milliseconds. */
  at: number;
  error?: string;
}

/** The New / Edit Canvas sheet. `root` is the table to suggest for "A table and its neighbours". */
export type CanvasSheet = { connId: string; mode: "new"; root?: string } | { connId: string; mode: "edit"; canvasId: string };

/**
 * Where canvases belong: a connection's database on PostgreSQL, where each database has its own;
 * on MySQL one set covers every database the connection shows.
 */
interface Place {
  profileId: string;
  database: string;
}

const placeOf = (conn: ConnTab): Place => ({
  profileId: conn.profile.id,
  database: conn.profile.engine === "postgres" ? conn.database : "",
});
const keyOf = (place: Place) => `${place.profileId}/${place.database}`;
/** Key of `byPlace` for a connection tab. */
export const placeKey = (conn: ConnTab) => keyOf(placeOf(conn));

interface PlaceCanvases {
  /** `null` when there never was a canvas here; a "Whole database" one is made when it is first shown. */
  list: Canvas[] | null;
  active: string | null;
}

interface CanvasState {
  /** By `placeKey`: tabs of the same connection and database share their canvases. */
  byPlace: Record<string, PlaceCanvases>;
  /** By canvas id. */
  saves: Record<string, SaveStatus>;
  sheet: CanvasSheet | null;
  /** A canvas that was just made: zoom it to fit when it is shown. */
  fit: string | null;

  /** Read the canvases of the connection's database, the first time only: after that this window holds the latest. */
  load(conn: ConnTab): Promise<void>;
  /** Put new tables on the canvases that add them by themselves (after the schema was read again). */
  sync(conn: ConnTab): void;
  /** Start a "Whole database" canvas where there never was one. */
  ensure(conn: ConnTab, temporary: boolean): void;
  create(conn: ConnTab, spec: CanvasSpec): void;
  edit(conn: ConnTab, id: string, spec: CanvasSpec): void;
  /** Change a canvas and save it shortly after. `quiet` changes (zoom, scroll) don't show "Saving…". */
  update(conn: ConnTab, id: string, change: (c: Canvas) => Canvas, opts?: { quiet?: boolean }): void;
  /** "Got it" on the banner. */
  acknowledge(conn: ConnTab, id: string): void;
  open(conn: ConnTab, id: string): void;
  duplicate(conn: ConnTab, id: string): void;
  remove(conn: ConnTab, id: string): Promise<void>;
  /** Write pending changes now (the connection is closing). */
  flush(profileId: string): void;
  /** The connection was deleted, and its canvases with it. */
  forget(profileId: string): void;
  setSheet(sheet: CanvasSheet | null): void;
  clearFit(): void;
}

const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; place: Place; loud: boolean }>();
const queues = new Map<string, Promise<void>>();
/** Places whose canvases were read. This window is the only one that changes them, so the list in
 * memory stays the latest; reading again could undo changes that are not saved yet. */
const loaded = new Set<string>();

const uid = () => crypto.randomUUID();

/** Copy of `name` that no other canvas uses: "Legal copy", "Legal copy 2", … */
function copyName(name: string, list: Canvas[]): string {
  const taken = new Set(list.map((c) => c.name));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name} copy` : `${name} copy ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const useCanvases = create<CanvasState>((set, get) => {
  const listOf = (place: Place) => get().byPlace[keyOf(place)]?.list ?? null;
  const find = (place: Place, id: string) => listOf(place)?.find((c) => c.id === id);

  const setList = (place: Place, change: (list: Canvas[]) => Canvas[], active?: string | null) =>
    set((s) => {
      const key = keyOf(place);
      const cur = s.byPlace[key] ?? { list: null, active: null };
      return {
        byPlace: {
          ...s.byPlace,
          [key]: { list: change(cur.list ?? []), active: active === undefined ? cur.active : active },
        },
      };
    });

  const setStatus = (id: string, status: SaveStatus) => set((s) => ({ saves: { ...s.saves, [id]: status } }));

  /** Save one canvas as it is now; saves of the same canvas run one after the other. */
  const persist = (place: Place, canvas: Canvas, loud: boolean) => {
    if (loud) setStatus(canvas.id, { state: "saving", at: get().saves[canvas.id]?.at ?? 0 });
    const run = async () => {
      try {
        const saved = await api.saveCanvas(place.profileId, place.database, canvas);
        setList(place, (list) =>
          list.map((c) => (c.id === saved.id ? { ...c, createdAt: saved.createdAt, updatedAt: saved.updatedAt } : c)),
        );
        if (loud || get().saves[canvas.id]?.state !== "saved") setStatus(canvas.id, { state: "saved", at: Date.now() });
      } catch (e) {
        setStatus(canvas.id, { state: "failed", at: get().saves[canvas.id]?.at ?? 0, error: (e as AppError).message });
      }
    };
    const next = (queues.get(canvas.id) ?? Promise.resolve()).then(run);
    queues.set(canvas.id, next);
    void next.finally(() => queues.get(canvas.id) === next && queues.delete(canvas.id));
  };

  const schedule = (place: Place, id: string, loud: boolean) => {
    const pending = timers.get(id);
    if (pending) clearTimeout(pending.timer);
    const isLoud = loud || !!pending?.loud;
    if (isLoud) setStatus(id, { state: "saving", at: get().saves[id]?.at ?? 0 });
    const timer = setTimeout(() => {
      timers.delete(id);
      const latest = find(place, id);
      if (latest) persist(place, latest, isLoud);
    }, SAVE_DELAY);
    timers.set(id, { timer, place, loud: isLoud });
  };

  const replace = (place: Place, canvas: Canvas) =>
    setList(place, (list) => list.map((c) => (c.id === canvas.id ? canvas : c)));

  return {
    byPlace: {},
    saves: {},
    sheet: null,
    fit: null,

    async load(conn) {
      const place = placeOf(conn);
      const key = keyOf(place);
      if (loaded.has(key)) return get().sync(conn);
      try {
        const read = await api.listCanvases(place.profileId, place.database);
        loaded.add(key);
        set((s) => {
          // Canvases made here after a failed read are kept.
          const here = (s.byPlace[key]?.list ?? []).filter((c) => !read?.some((r) => r.id === c.id));
          const list = read || here.length ? [...(read ?? []), ...here] : null;
          const prev = s.byPlace[key]?.active;
          const active = list?.some((c) => c.id === prev) ? prev! : (list?.[0]?.id ?? null);
          return { byPlace: { ...s.byPlace, [key]: { list, active } } };
        });
        get().sync(conn);
      } catch (e) {
        set((s) => ({ byPlace: { ...s.byPlace, [key]: s.byPlace[key] ?? { list: [], active: null } } }));
        showToast(`Couldn't read the canvases: ${(e as AppError).message}`, "error");
      }
    },

    sync(conn) {
      const place = placeOf(conn);
      const list = listOf(place);
      if (!list || !conn.schema) return;
      const schema = indexSchema(conn.schema);
      for (const c of list) {
        const next = addNewTables(c, schema, changesOf(c, schema));
        if (next !== c) {
          replace(place, next);
          schedule(place, c.id, false);
        }
      }
    },

    ensure(conn, temporary) {
      const entry = get().byPlace[placeKey(conn)];
      if (temporary || !conn.schema || !entry || entry.list !== null) return;
      get().create(conn, { name: "Whole database", scope: { kind: "all" }, autoAdd: true });
    },

    create(conn, spec) {
      if (!conn.schema) return;
      const place = placeOf(conn);
      const canvas = newCanvas(spec, indexSchema(conn.schema), uid());
      setList(place, (list) => [...list, canvas], canvas.id);
      set({ fit: canvas.id });
      persist(place, canvas, true);
    },

    edit(conn, id, spec) {
      const place = placeOf(conn);
      const c = find(place, id);
      if (!c || !conn.schema) return;
      const next = rescope(c, spec, indexSchema(conn.schema));
      setList(place, (list) => list.map((x) => (x.id === id ? next : x)), id);
      schedule(place, id, true);
    },

    update(conn, id, change, opts) {
      const place = placeOf(conn);
      const c = find(place, id);
      if (!c) return;
      const next = change(c);
      if (next === c) return;
      replace(place, next);
      schedule(place, id, !opts?.quiet);
    },

    acknowledge(conn, id) {
      if (conn.schema) get().update(conn, id, (c) => acknowledge(c, indexSchema(conn.schema!)));
    },

    open(conn, id) {
      setList(placeOf(conn), (list) => list, id);
    },

    duplicate(conn, id) {
      const place = placeOf(conn);
      const list = listOf(place) ?? [];
      const c = list.find((x) => x.id === id);
      if (!c) return;
      const copy = duplicate(c, uid(), copyName(c.name, list));
      setList(place, (l) => [...l, copy], copy.id);
      persist(place, copy, true);
    },

    async remove(conn, id) {
      const place = placeOf(conn);
      const list = listOf(place) ?? [];
      const i = list.findIndex((c) => c.id === id);
      if (i < 0) return;
      const canvas = list[i];
      const pending = timers.get(id);
      if (pending) (clearTimeout(pending.timer), timers.delete(id));
      try {
        await (queues.get(id) ?? Promise.resolve());
        await api.deleteCanvas(place.profileId, place.database, id);
      } catch (e) {
        showToast(`Couldn't delete the canvas: ${(e as AppError).message}`, "error");
        return;
      }
      const rest = (listOf(place) ?? []).filter((c) => c.id !== id);
      const active = get().byPlace[keyOf(place)]?.active;
      setList(place, () => rest, active === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : active);
      showToast(`Deleted “${canvas.name}”`, "ok", {
        label: "Undo",
        run: () => {
          setList(place, (l) => [...l.slice(0, i), canvas, ...l.slice(i)], canvas.id);
          persist(place, canvas, true);
        },
      });
    },

    flush(profileId) {
      for (const [id, p] of timers) {
        if (p.place.profileId !== profileId) continue;
        clearTimeout(p.timer);
        timers.delete(id);
        const latest = find(p.place, id);
        if (latest) persist(p.place, latest, p.loud);
      }
    },

    forget(profileId) {
      const mine = (key: string) => key.startsWith(`${profileId}/`);
      for (const key of loaded) if (mine(key)) loaded.delete(key);
      for (const [id, p] of timers) if (p.place.profileId === profileId) (clearTimeout(p.timer), timers.delete(id));
      set((s) => ({ byPlace: Object.fromEntries(Object.entries(s.byPlace).filter(([key]) => !mine(key))) }));
    },

    setSheet(sheet) {
      set({ sheet });
    },

    clearFit() {
      set({ fit: null });
    },
  };
});
