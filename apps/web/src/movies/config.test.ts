import { decideRoute, parse } from "@alfred/agent-harness";
import { describe, expect, it } from "vitest";
import { SAMPLE_CATALOG } from "./sample-catalog.fixture";
import { buildMovieParserConfig, MOVIE_ROUTER_OPTIONS } from "./config";
import { chipsToSearchHints } from "./hints";
import { byRating, filterCatalog } from "./tools";

const config = buildMovieParserConfig(SAMPLE_CATALOG);
const chipsOf = (q: string) => parse(q, config).chips.map((c) => `${c.negate ? "!" : ""}${c.kind}:${c.label}`);
const filtered = (q: string, watched = new Set<number>()) => filterCatalog(SAMPLE_CATALOG, chipsToSearchHints(parse(q, config).chips), watched).sort(byRating);
const titlesOf = (q: string) => filtered(q).map((m) => m.title);
const routeOf = (q: string) => decideRoute(parse(q, config), MOVIE_ROUTER_OPTIONS).route;

describe("a maximum rating", () => {
  it.each(["below 7 stars", "under 5 stars", "less than 6 stars", "under 7 rating"])("gives no filter, never the opposite: %s", (q) => {
    const parsed = parse(q, config);
    expect(parsed.chips).toEqual([]);
    expect(parsed.trace.join(" ")).toContain("no filter for a maximum rating");
  });

  it("keeps a minimum rating", () => {
    expect(chipsOf("over 7 stars")).toEqual(["rating:Rating ≥ 7"]);
  });
});

describe("negated filters are not applied", () => {
  it.each(["not over 2 hours", "no 90s movies", "not highly rated", "no short movies", "not like inception", "not recent"])("%s", (q) => {
    const parsed = parse(q, config);
    expect(parsed.chips).toEqual([]);
    expect(parsed.leftover.length).toBeGreaterThan(0);
    expect(parsed.trace.join(" ")).toContain("cannot be excluded");
  });

  it("a filter after a completed exclusion still applies", () => {
    expect(chipsOf("not sci-fi, under 2 hours")).toEqual(["!genre:Sci-fi", "runtime:≤ 120 min"]);
  });
});

describe("like a title with several movies", () => {
  const heat = SAMPLE_CATALOG.find((m) => m.title === "Heat")!;
  const remakes = [{ ...heat, id: 9001, year: 2020, votes: 10 }, { ...heat, id: 9002, year: 1995, votes: 5000 }, { ...heat, id: 9003, year: 1986, votes: 20 }];
  const similarOf = (q: string, movies = remakes) => parse(q, buildMovieParserConfig(movies)).chips.find((c) => c.kind === "similar")?.id;

  it("picks the most voted movie, in any catalog order", () => {
    expect(similarOf("like heat")).toBe("9002");
    expect(similarOf("like heat", [...remakes].reverse())).toBe("9002");
  });

  it("prefers an exact title to the part before a colon", () => {
    const dune = [{ ...heat, id: 1, title: "Dune: Part Two", votes: 9000 }, { ...heat, id: 2, title: "Dune", votes: 10 }];
    expect(similarOf("like dune", dune)).toBe("2");
    expect(similarOf("like dune", dune.slice(0, 1))).toBe("1");
  });

  it("does not read a stripped original title as a movie", () => {
    const projectA = [{ ...heat, id: 5, title: "Project A", originalTitle: "A計劃", votes: 10 }];
    expect(similarOf("something like a heist gone wrong", projectA)).toBeUndefined();
  });

  it("reads a pronoun as a title only with more words", () => {
    const it2 = [{ ...heat, id: 3, title: "It Follows", votes: 10 }, { ...heat, id: 4, title: "It", votes: 10 }];
    expect(similarOf("like it follows", it2)).toBe("3");
    expect(similarOf("like it", it2)).toBeUndefined();
  });
});

describe("plot words stay plot text", () => {
  it.each([
    ["a boy who lives under a bridge", []],
    ["a fight over a woman", []],
    ["under one roof", []],
    ["a heist in new york", []],
    ["an old man and his dog", []],
    ["a 12 year old boy finds a dragon", []],
    ["short man with big dreams", []],
    ["something like it", []],
    ["like her", []],
    ["an old, lonely man", []],
  ])("%s", (q, expected) => {
    expect(chipsOf(q)).toEqual(expected);
  });

  it.each([
    ["under an hour", ["runtime:≤ 60 min"]],
    ["over two hours", ["runtime:≥ 120 min"]],
    ["short comedy", ["runtime:≤ 100 min", "genre:Comedy"]],
    ["quick sci-fi movie", ["runtime:≤ 100 min", "genre:Sci-fi"]],
    ["old movies", ["year:Before 2000"]],
    ["new horror", ["year:2015 or later", "genre:Horror"]],
    ["something recent", ["year:2015 or later"]],
    ["classic", ["year:Before 2000"]],
    ["something short?", ["runtime:≤ 100 min"]],
  ])("still filters: %s", (q, expected) => {
    expect(chipsOf(q)).toEqual(expected);
  });
});

describe("numbers: rating or runtime", () => {
  it.each([
    ["movie above 7", ["rating:Rating ≥ 7"]],
    ["over 7 stars", ["rating:Rating ≥ 7"]],
    ["rated 8", ["rating:Rating ≥ 8"]],
    ["rated at least 7.5 stars", ["rating:Rating ≥ 7.5"]],
    ["7+ comedy", ["rating:Rating ≥ 7", "genre:Comedy"]],
    ["8/10 drama", ["rating:Rating ≥ 8", "genre:Drama"]],
    ["highly rated", ["rating:Rating ≥ 8"]],
    ["under 2 hours", ["runtime:≤ 120 min"]],
    ["under 2", ["runtime:≤ 120 min"]],
    ["under 90", ["runtime:≤ 90 min"]],
    ["over 150", ["runtime:≥ 150 min"]],
    ["longer than 2", ["runtime:≥ 120 min"]],
    ["at least 2 hours", ["runtime:≥ 120 min"]],
    ["less than 100min", ["runtime:≤ 100 min"]],
    ["short", ["runtime:≤ 100 min"]],
  ])("%s", (q, expected) => {
    expect(chipsOf(q)).toEqual(expected);
  });

  it("does not guess an ambiguous number", () => {
    const r = parse("under 15", config);
    expect(r.chips).toEqual([]);
    expect(r.trace.join(" ")).toMatch(/ambiguous/);
  });
});

describe("with, without, has, does not have", () => {
  it.each([
    ["a movie with pacino", ["actor:Al Pacino"]],
    ["movie that has de niro", ["actor:Robert De Niro"]],
    ["crime having pacino", ["genre:Crime", "actor:Al Pacino"]],
    ["crime without de niro", ["genre:Crime", "!actor:Robert De Niro"]],
    ["movie above 7 that does not have horror", ["rating:Rating ≥ 7", "!genre:Horror"]],
    ["doesn't have pacino", ["!actor:Al Pacino"]],
    ["sci-fi that isn't animated", ["genre:Sci-fi", "!genre:Animation"]],
    ["with no horror", ["!genre:Horror"]],
    ["non-horror thriller", ["!genre:Horror", "genre:Thriller"]],
  ])("%s", (q, expected) => {
    expect(chipsOf(q)).toEqual(expected);
  });
});

describe("surname-only matching", () => {
  it("does not match a surname that is a title word", () => {
    const catalog = [...SAMPLE_CATALOG, { ...SAMPLE_CATALOG[0]!, id: 999, title: "Toy Story", cast: ["Tim Story"], directors: [] }, { ...SAMPLE_CATALOG[0]!, id: 998, title: "Other", cast: ["Tim Story"], directors: [] }];
    const strict = buildMovieParserConfig(catalog);
    expect(parse("a story about pacino", strict).chips.map((c) => c.id)).toEqual(["Al Pacino"]);
  });
});

describe("years and titles", () => {
  it.each([
    ["a 90s crime movie with pacino", ["year:1990s", "genre:Crime", "actor:Al Pacino"]],
    ["after 2015", ["year:From 2015"]],
    ["before 2000", ["year:Before 2000"]],
    ["like inception", ["similar:Inception"]],
    ["similar to the matrix", ["similar:The Matrix"]],
  ])("%s", (q, expected) => {
    expect(chipsOf(q)).toEqual(expected);
  });
});

describe("questions go to the assistant (rule B)", () => {
  it.each([
    "is heat worth watching?",
    "what is memento about",
    "what's inception about?",
    "tell me about the matrix",
    "who directed taxi driver",
    "how long is the irishman",
    "should i watch scarface",
    "why is the godfather so famous",
    "difference between heat and the irishman",
  ])("%s", (q) => {
    expect(routeOf(q)).toBe("assistant");
  });

  it.each([
    ["what is a good comedy", "local"],
    ["a movie about a heist", "semantic"],
    ["mind-bending dream heist", "semantic"],
  ])("%s stays a search", (q, route) => {
    expect(routeOf(q)).toBe(route);
  });
});

describe("end to end: chips, route and results", () => {
  it("filters by actor and genre locally", () => {
    expect(routeOf("a jennifer lawrence action movie")).toBe("local");
    expect(titlesOf("a jennifer lawrence action movie")).toEqual(["X-Men: First Class", "The Hunger Games: Catching Fire", "The Hunger Games", "Red Sparrow"]);
  });

  it("requires every named actor", () => {
    expect(titlesOf("movie with deNiro and pacino")).toEqual(["The Godfather Part II", "Heat", "The Irishman", "Righteous Kill"]);
  });

  it("sends a similar-title query to semantic search", () => {
    expect(routeOf("like inception but not sci-fi, under 2 hours")).toBe("semantic");
    const movies = filtered("like inception but not sci-fi, under 2 hours");
    expect(movies.length).toBeGreaterThan(0);
    expect(movies.every((m) => !m.genres.includes("sci-fi") && m.runtime <= 120)).toBe(true);
  });

  it("sends a group task to the assistant", () => {
    expect(routeOf("plan a movie night for me and a friend who hates horror")).toBe("assistant");
  });

  it("hides watched movies", () => {
    const heat = SAMPLE_CATALOG.find((m) => m.title === "Heat")!;
    expect(titlesOf("pacino crime")).toContain("Heat");
    expect(filtered("pacino crime", new Set([heat.id])).map((m) => m.title)).not.toContain("Heat");
  });
});
