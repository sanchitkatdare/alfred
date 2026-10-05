import { describe, expect, it } from "vitest";
import { SAMPLE_CATALOG } from "./sample-catalog.fixture";
import { createMovieTools, movieToolSpecs, type MovieToolContext } from "./tools";

function setup(watched: number[] = []) {
  const searches: { text: string; ids?: number[] }[] = [];
  const marked: number[] = [];
  const ctx: MovieToolContext = {
    catalog: SAMPLE_CATALOG,
    getWatched: () => new Set(watched),
    markWatched: (id) => marked.push(id),
    // Fake semantic search: reverse id order, so ranking differs from rating order.
    search: async (text, ids) => {
      searches.push({ text, ids });
      return (ids ?? SAMPLE_CATALOG.map((m) => m.id)).sort((a, b) => b - a).map((id, i) => ({ id, score: 1 - i / 100 }));
    },
    details: async (ids) => ids.map((id) => ({ id, overview: `Overview ${id}`, tagline: "", keywords: "k" })),
  };
  const tools = Object.fromEntries(createMovieTools(ctx).map((t) => [t.name, t]));
  const run = (name: string, args: unknown) => tools[name]!.run(tools[name]!.schema.parse(args), { callId: "t" });
  return { run, searches, marked };
}

describe("search_movies", () => {
  it("filters by genre, runtime and exclusion, sorted by rating without a query", async () => {
    const { run } = setup();
    const r = await run("search_movies", { genres: ["comedy"], excludeGenres: ["animation"], maxRuntime: 120 });
    expect(r.movies.map((m: { title: string }) => m.title)).toEqual(["Paddington 2", "Superbad"]);
  });

  it("matches people by full name or surname", async () => {
    const { run } = setup();
    const r = await run("search_movies", { people: ["De Niro", "al pacino"], limit: 10 });
    expect(r.matches).toBe(4);
  });

  it("leaves out watched movies unless asked", async () => {
    const heat = SAMPLE_CATALOG.find((m) => m.title === "Heat")!.id;
    const { run } = setup([heat]);
    expect((await run("search_movies", { people: ["Pacino"], limit: 10 })).matches).toBe(4);
    expect((await run("search_movies", { people: ["Pacino"], includeWatched: true, limit: 10 })).matches).toBe(5);
  });

  it("ranks filtered candidates with semantic search when a query is given", async () => {
    const { run, searches } = setup();
    const r = await run("search_movies", { query: "dream heist", people: ["Nolan"] });
    expect(searches[0]!.ids?.sort()).toEqual([1, 2, 3]);
    expect(r.movies.map((m: { id: number }) => m.id)).toEqual([3, 2, 1]);
  });

  it("finds a named movie by title, including watched movies", async () => {
    const { run } = setup([1]);
    const r = await run("search_movies", { title: "inception" });
    expect(r.movies.map((m: { title: string }) => m.title)).toEqual(["Inception"]);
  });

  it("rejects unknown genres", () => {
    expect(() => setup().run("search_movies", { genres: ["slasher"] })).toThrow();
  });
});

describe("other tools", () => {
  it("returns story details for known ids", async () => {
    const r = await setup().run("get_movie_details", { ids: [1] });
    expect(r[0]).toMatchObject({ id: 1, title: "Inception", overview: "Overview 1" });
  });

  it("rejects unknown ids with a hint", async () => {
    await expect(setup().run("get_movie_details", { ids: [999999] })).rejects.toThrow(/Use ids from search_movies/);
  });

  it("marks a movie as watched", async () => {
    const { run, marked } = setup();
    expect(await run("mark_watched", { id: 4 })).toEqual({ marked: { id: 4, title: "Heat" } });
    expect(marked).toEqual([4]);
  });

  it("exposes JSON Schema specs for the server", () => {
    const specs = movieToolSpecs();
    expect(specs.map((s) => s.name)).toEqual(["search_movies", "get_movie_details", "get_watched_list", "mark_watched"]);
    expect(JSON.stringify(specs[0]!.parameters)).toContain('"sci-fi"');
  });
});

describe("search_movies with parser hints", () => {
  it("applies hints to filter searches but not to title lookups", async () => {
    const tools = Object.fromEntries(createMovieTools({
      catalog: SAMPLE_CATALOG, getWatched: () => new Set(), markWatched: () => {},
      search: async () => [], details: async () => [],
      getHints: () => ({ excludeGenres: ["sci-fi"] }),
    }).map((t) => [t.name, t]));
    const run = (args: unknown) => tools.search_movies!.run(tools.search_movies!.schema.parse(args), { callId: "t" });
    const filtered = await run({ people: ["Nolan"], limit: 10 });
    expect(filtered.movies.map((m: { title: string }) => m.title)).toEqual(["The Dark Knight"]);
    const byTitle = await run({ title: "inception" });
    expect(byTitle.movies.map((m: { title: string }) => m.title)).toEqual(["Inception"]);
  });
});
