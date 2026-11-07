import { describe, expect, it } from "vitest";
import { loadWatched, saveWatched, withWatched } from "./useWatched";

const memory = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [["alfred.movies.watched", initial]]);
  return { data, storage: () => ({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }) };
};
const blocked = () => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};
const full = () => ({ getItem: () => null, setItem: () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); } });

describe("watched list storage", () => {
  it("round-trips the list", () => {
    const { storage } = memory();
    saveWatched([3, 1, 2], storage);
    expect(loadWatched(storage)).toEqual([3, 1, 2]);
  });

  it.each([
    ["damaged JSON", "[1, 2"],
    ["a value that is not a list", '{"ids":[1]}'],
  ])("starts empty for %s", (_, stored) => {
    expect(loadWatched(memory(stored).storage)).toEqual([]);
  });

  it("drops entries that are not movie ids", () => {
    expect(loadWatched(memory('[1, "2", null, 3]').storage)).toEqual([1, 3]);
  });

  it("works without storage: private mode and a full quota neither throw nor lose the session's list", () => {
    expect(loadWatched(blocked)).toEqual([]);
    expect(() => saveWatched([1], blocked)).not.toThrow();
    expect(() => saveWatched([1], full)).not.toThrow();
  });

  it("keeps the newest 500 entries, and moves a re-marked movie to the end", () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    const next = withWatched(ids, 501);
    expect(next).toHaveLength(500);
    expect(next[0]).toBe(2);
    expect(next.at(-1)).toBe(501);
    expect(withWatched([1, 2, 3], 1)).toEqual([2, 3, 1]);
  });

  it("caps a stored list that grew past 500 in an older version", () => {
    const stored = JSON.stringify(Array.from({ length: 600 }, (_, i) => i));
    expect(loadWatched(memory(stored).storage)).toHaveLength(500);
  });
});
