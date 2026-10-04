import { createToolRegistry, defineTool, toKey, type Tool, type ToolSpec } from "@alfred/agent-harness";
import { z } from "zod";
import type { Movie } from "./catalog";
import { GENRE_IDS } from "./config";

export interface MovieStory {
  id: number;
  overview: string;
  tagline: string;
  keywords: string;
}

/** Everything the tools need. The browser and the comparison script each supply their own. */
export interface MovieToolContext {
  catalog: Movie[];
  getWatched(): ReadonlySet<number>;
  markWatched(id: number): void;
  /** Semantic search. With `ids`, ranks only those candidates. */
  search(text: string, ids?: number[]): Promise<{ id: number; score: number }[]>;
  /** Overview, tagline and keywords from the server. */
  details(ids: number[]): Promise<MovieStory[]>;
}

/** Above this many filtered movies, semantic search queries the whole index instead of ranking candidates. */
const MAX_CANDIDATES = 200;

const genre = z.enum(GENRE_IDS as [string, ...string[]]);

const searchSchema = z.object({
  title: z.string().min(1).max(100).optional().describe("Part of a title, e.g. 'memento'. Use it to find a movie the user names. Title searches include watched movies."),
  query: z.string().max(200).optional().describe("Free text for themes, plot elements or mood, e.g. 'dream heist' or 'feel-good'. Omit for filter-only searches."),
  genres: z.array(genre).max(5).optional().describe("Every listed genre must match."),
  excludeGenres: z.array(genre).max(5).optional(),
  people: z.array(z.string().min(2)).max(4).optional().describe("Actor or director names. Every listed person must appear."),
  excludePeople: z.array(z.string().min(2)).max(4).optional(),
  minRating: z.number().min(0).max(10).optional().describe("TMDB rating out of 10."),
  minRuntime: z.number().int().min(0).max(400).optional().describe("Minutes."),
  maxRuntime: z.number().int().min(30).max(400).optional().describe("Minutes."),
  yearFrom: z.number().int().min(1900).max(2100).optional(),
  yearTo: z.number().int().min(1900).max(2100).optional(),
  includeWatched: z.boolean().optional().describe("Default false: movies the user watched are left out."),
  limit: z.number().int().min(1).max(10).optional().describe("Default 5."),
});

type SearchArgs = z.infer<typeof searchSchema>;

const personMatches = (movie: Movie, name: string) => {
  const k = toKey(name);
  return [...movie.cast, ...movie.directors].some((p) => toKey(p) === k || toKey(p).endsWith(k));
};

function filterCatalog(catalog: Movie[], a: SearchArgs, watched: ReadonlySet<number>): Movie[] {
  const title = a.title ? toKey(a.title) : "";
  return catalog.filter((m) =>
    (!title || toKey(m.title).includes(title) || toKey(m.originalTitle ?? "").includes(title)) &&
    (a.genres ?? []).every((g) => m.genres.includes(g)) &&
    !(a.excludeGenres ?? []).some((g) => m.genres.includes(g)) &&
    (a.people ?? []).every((p) => personMatches(m, p)) &&
    !(a.excludePeople ?? []).some((p) => personMatches(m, p)) &&
    (a.minRating === undefined || m.rating >= a.minRating) &&
    (a.minRuntime === undefined || m.runtime >= a.minRuntime) &&
    (a.maxRuntime === undefined || m.runtime <= a.maxRuntime) &&
    (a.yearFrom === undefined || m.year >= a.yearFrom) &&
    (a.yearTo === undefined || m.year <= a.yearTo) &&
    (a.includeWatched || !!title || !watched.has(m.id)),
  );
}

const summary = (m: Movie) => ({
  id: m.id, title: m.title, year: m.year, runtime: m.runtime, rating: m.rating,
  genres: m.genres, cast: m.cast.slice(0, 3), directors: m.directors,
});

export function createMovieTools(ctx: MovieToolContext): Tool<any, any>[] {
  const byId = new Map(ctx.catalog.map((m) => [m.id, m]));

  const searchMovies = defineTool({
    name: "search_movies",
    description: "Find movies in the catalog by filters and an optional free-text description. Returns at most `limit` movies, best first.",
    schema: searchSchema,
    async run(a) {
      const filtered = filterCatalog(ctx.catalog, a, ctx.getWatched());
      const limit = a.limit ?? 5;
      let ordered: Movie[];
      if (a.query && filtered.length) {
        const allowed = new Set(filtered.map((m) => m.id));
        const ranked = filtered.length <= MAX_CANDIDATES
          ? await ctx.search(a.query, [...allowed])
          : (await ctx.search(a.query)).filter((r) => allowed.has(r.id));
        ordered = ranked.map((r) => byId.get(r.id)).filter((m): m is Movie => !!m);
      } else {
        ordered = [...filtered].sort((x, y) => y.rating - x.rating || (y.votes ?? 0) - (x.votes ?? 0));
      }
      return { matches: filtered.length, movies: ordered.slice(0, limit).map(summary) };
    },
  });

  const getDetails = defineTool({
    name: "get_movie_details",
    description: "Get the overview, tagline and keywords of movies by id. Use this before answering questions about a movie's story.",
    schema: z.object({ ids: z.array(z.number().int()).min(1).max(5) }),
    async run({ ids }) {
      const known = ids.filter((id) => byId.has(id));
      if (!known.length) throw new Error(`Unknown movie ids: ${ids.join(", ")}. Use ids from search_movies.`);
      const stories = new Map((await ctx.details(known)).map((s) => [s.id, s]));
      return known.map((id) => ({ ...summary(byId.get(id)!), ...stories.get(id) }));
    },
  });

  const getWatched = defineTool({
    name: "get_watched_list",
    description: "List the movies the user has marked as watched.",
    schema: z.object({}),
    async run() {
      return [...ctx.getWatched()].map((id) => byId.get(id)).filter((m): m is Movie => !!m).slice(-100).map((m) => ({ id: m.id, title: m.title, year: m.year }));
    },
  });

  const markWatched = defineTool({
    name: "mark_watched",
    description: "Mark a movie as watched by id.",
    schema: z.object({ id: z.number().int() }),
    idempotent: true,
    async run({ id }) {
      const movie = byId.get(id);
      if (!movie) throw new Error(`Unknown movie id ${id}. Use an id from search_movies.`);
      ctx.markWatched(id);
      return { marked: { id, title: movie.title } };
    },
  });

  return [searchMovies, getDetails, getWatched, markWatched];
}

/** Tool specs for the server. Only schemas are read, so the context is never called. */
export function movieToolSpecs(): ToolSpec[] {
  const unused = () => {
    throw new Error("Tool specs only");
  };
  return createToolRegistry(createMovieTools({ catalog: [], getWatched: unused, markWatched: unused, search: unused, details: unused })).specs();
}
