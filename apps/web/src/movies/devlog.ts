import { useCallback, useState } from "react";

/** Pipeline stage of a dev-mode item. */
export type Stage = "data" | "rules" | "search" | "assistant";

export interface DevItem {
  stage: Stage;
  label: string;
  detail?: string;
  ms?: number;
  neurons?: number;
  /** True when the item made a request to our API. */
  serverCall?: boolean;
}

export interface DevEntry {
  id: number;
  kind: "load" | "search" | "assistant" | "lookup";
  title: string;
  started: number;
  ms?: number;
  items: DevItem[];
}

const MAX_ENTRIES = 10;
let nextId = 1;

/** Request log for dev mode: one entry per page load, search or assistant run, newest first. */
export function useDevLog() {
  const [entries, setEntries] = useState<DevEntry[]>([]);
  const start = useCallback((kind: DevEntry["kind"], title: string) => {
    const id = nextId++;
    setEntries((all) => [{ id, kind, title, started: performance.now(), items: [] }, ...all].slice(0, MAX_ENTRIES));
    return id;
  }, []);
  const add = useCallback((id: number | null, item: DevItem) => {
    if (id === null) return;
    setEntries((all) => all.map((e) => (e.id === id ? { ...e, items: [...e.items, item] } : e)));
  }, []);
  const finish = useCallback((id: number) => {
    setEntries((all) => all.map((e) => (e.id === id ? { ...e, ms: Math.round(performance.now() - e.started) } : e)));
  }, []);
  return { entries, start, add, finish };
}

export type DevLog = ReturnType<typeof useDevLog>;

export const totals = (entry: DevEntry) => ({
  neurons: entry.items.reduce((n, i) => n + (i.neurons ?? 0), 0),
  serverCalls: entry.items.filter((i) => i.serverCall).length,
});
