import type { Chip } from "@alfred/agent-harness";

/** Hard filters taken from the user's own words by the rule parser. */
export interface SearchHints {
  genres?: string[];
  excludeGenres?: string[];
  people?: string[];
  excludePeople?: string[];
  minRating?: number;
  minRuntime?: number;
  maxRuntime?: number;
  yearFrom?: number;
  yearTo?: number;
}

const num = (c: Chip, k: string) => (typeof c.data?.[k] === "number" ? (c.data[k] as number) : undefined);
const push = (list: string[] | undefined, v: string) => [...new Set([...(list ?? []), v])];

/** Converts parser chips to search filters. Task, user-data and "like" chips carry no filter. */
export function chipsToSearchHints(chips: Chip[]): SearchHints {
  const h: SearchHints = {};
  for (const c of chips) {
    if (c.kind === "genre") {
      if (c.negate) h.excludeGenres = push(h.excludeGenres, c.id);
      else h.genres = push(h.genres, c.id);
    } else if (c.kind === "actor" || c.kind === "director") {
      if (c.negate) h.excludePeople = push(h.excludePeople, c.id);
      else h.people = push(h.people, c.id);
    } else if (c.kind === "rating") {
      h.minRating = num(c, "min");
    } else if (c.kind === "runtime") {
      if (num(c, "min") !== undefined) h.minRuntime = num(c, "min");
      if (num(c, "max") !== undefined) h.maxRuntime = num(c, "max");
    } else if (c.kind === "year") {
      if (num(c, "min") !== undefined) h.yearFrom = num(c, "min");
      if (num(c, "max") !== undefined) h.yearTo = num(c, "max");
    }
  }
  return h;
}

/**
 * Applies hints on top of the model's arguments. Lists are merged; numbers from the hints win,
 * because they come from the user's words. A genre or person cannot be both required and excluded:
 * the hint decides.
 */
export function mergeSearchHints<A extends SearchHints>(args: A, hints: SearchHints): A {
  const out: A = { ...args };
  const union = (a?: string[], b?: string[]) => (a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined);
  const without = (list: string[] | undefined, remove: string[] | undefined) => list?.filter((v) => !(remove ?? []).includes(v));

  out.genres = without(union(args.genres, hints.genres), hints.excludeGenres);
  out.excludeGenres = without(union(args.excludeGenres, hints.excludeGenres), hints.genres);
  out.people = without(union(args.people, hints.people), hints.excludePeople);
  out.excludePeople = without(union(args.excludePeople, hints.excludePeople), hints.people);
  for (const k of ["minRating", "minRuntime", "maxRuntime", "yearFrom", "yearTo"] as const) {
    if (hints[k] !== undefined) out[k] = hints[k] as A[typeof k];
  }
  for (const k of Object.keys(out) as (keyof A)[]) {
    const v = out[k];
    if (v === undefined || (Array.isArray(v) && !v.length)) delete out[k];
  }
  return out;
}
