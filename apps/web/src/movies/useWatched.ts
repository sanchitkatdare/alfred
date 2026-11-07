import { useCallback, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "alfred.movies.watched";
/** Keep the most recent entries only. */
const LIMIT = 500;

type GetStorage = () => Pick<Storage, "getItem" | "setItem">;
// A getter: in some private modes even reading `localStorage` throws.
const browserStorage: GetStorage = () => localStorage;

/** The stored list. Blocked storage or a damaged value gives an empty list; anything but numbers is dropped. */
export function loadWatched(storage = browserStorage): number[] {
  try {
    const value: unknown = JSON.parse(storage().getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number").slice(-LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveWatched(ids: number[], storage = browserStorage): void {
  try {
    storage().setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked or full. The list still works for this session.
  }
}

/** Adds a movie as the most recent entry, keeping the newest 500. */
export const withWatched = (ids: number[], id: number) => [...ids.filter((x) => x !== id), id].slice(-LIMIT);

/**
 * Watched movie IDs (TMDB IDs), stored per browser. A new browser starts empty.
 * The callbacks are stable, and getWatched() returns the latest list, so the assistant's
 * tools can read it during a run that spans several renders.
 */
export function useWatched() {
  const [ids, setIds] = useState<number[]>(() => loadWatched());
  const watched = useMemo(() => new Set(ids), [ids]);
  const latest = useRef(watched);
  latest.current = watched;

  const markWatched = useCallback((id: number) => {
    setIds((prev) => {
      const next = withWatched(prev, id);
      saveWatched(next);
      return next;
    });
  }, []);
  const unmark = useCallback((id: number) => {
    setIds((prev) => {
      const next = prev.filter((x) => x !== id);
      saveWatched(next);
      return next;
    });
  }, []);
  const clear = useCallback(() => {
    saveWatched([]);
    setIds([]);
  }, []);
  const getWatched = useCallback(() => latest.current, []);

  return { watched, getWatched, markWatched, unmark, clear };
}
