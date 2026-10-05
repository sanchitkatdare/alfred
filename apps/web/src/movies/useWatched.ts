import { useCallback, useMemo, useRef, useState } from "react";

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

/**
 * Watched movie IDs (TMDB IDs), stored per browser. A new browser starts empty.
 * The callbacks are stable, and getWatched() always returns the latest list, so the assistant's
 * tools can read and write it during a run that spans several renders.
 */
export function useWatched() {
  const [ids, setIds] = useState<number[]>(load);
  const watched = useMemo(() => new Set(ids), [ids]);
  const latest = useRef(watched);
  latest.current = watched;

  const markWatched = useCallback((id: number) => {
    setIds((prev) => {
      const next = [...prev.filter((x) => x !== id), id].slice(-LIMIT);
      save(next);
      latest.current = new Set(next);
      return next;
    });
  }, []);
  const clear = useCallback(() => {
    save([]);
    latest.current = new Set();
    setIds([]);
  }, []);
  const getWatched = useCallback(() => latest.current, []);

  return { watched, getWatched, markWatched, clear };
}
