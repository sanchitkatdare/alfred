import { useCallback, useState } from "react";

const STORAGE_KEY = "alfred.movies.watched";
/** Keep the most recent entries only. */
const LIMIT = 500;

function load(): number[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
  } catch {
    return [];
  }
}

function save(ids: number[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked or full. The list still works for this session.
  }
}

/** Watched movie IDs, stored per browser. A new browser starts empty. */
export function useWatched() {
  const [ids, setIds] = useState<number[]>(load);

  const update = useCallback((next: number[]) => {
    const capped = next.slice(-LIMIT);
    save(capped);
    setIds(capped);
  }, []);

  return {
    watched: new Set(ids),
    markWatched: (id: number) => update([...ids.filter((x) => x !== id), id]),
    clear: () => update([]),
  };
}
