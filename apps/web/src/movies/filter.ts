import type { Chip } from "@alfred/agent-harness";
import type { Movie } from "./catalog";

export interface FilterResult {
  movies: Movie[];
  /** Matches removed because the user marked them watched. */
  hiddenWatched: number;
}

const num = (c: Chip, k: string) => (typeof c.data?.[k] === "number" ? (c.data[k] as number) : null);

function passes(movie: Movie, c: Chip): boolean {
  const people = [...movie.cast, ...movie.directors];
  let hit: boolean;
  switch (c.kind) {
    case "genre":
      hit = movie.genres.includes(c.id);
      return c.negate ? !hit : hit;
    case "actor":
    case "director":
      hit = people.includes(c.id);
      return c.negate ? !hit : hit;
    case "runtime": {
      const min = num(c, "min"), max = num(c, "max");
      return (min === null || movie.runtime >= min) && (max === null || movie.runtime <= max);
    }
    case "year": {
      const min = num(c, "min"), max = num(c, "max");
      return (min === null || movie.year >= min) && (max === null || movie.year <= max);
    }
    case "rating":
      return movie.rating >= (num(c, "min") ?? 0);
    case "similar":
      return String(movie.id) !== c.id;
    default:
      return true;
  }
}

/**
 * Local filter for the live preview and the "local" route.
 * A "similar" chip ranks by shared genres. This is a preview only; semantic search replaces it on submit.
 */
export function filterMovies(catalog: Movie[], chips: Chip[], watched: ReadonlySet<number>): FilterResult {
  const similarId = chips.find((c) => c.kind === "similar")?.id;
  const ref = similarId ? catalog.find((m) => String(m.id) === similarId) : undefined;
  const overlap = (m: Movie) => (ref ? m.genres.filter((g) => ref.genres.includes(g)).length : 0);

  let list = catalog.filter((m) => chips.every((c) => passes(m, c)));
  if (ref) list = list.filter((m) => overlap(m) > 0);
  list.sort((a, b) => overlap(b) - overlap(a) || b.rating - a.rating);

  const visible = list.filter((m) => !watched.has(m.id));
  return { movies: visible, hiddenWatched: list.length - visible.length };
}
