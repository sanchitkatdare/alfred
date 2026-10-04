import { decideRoute, parse } from "@alfred/agent-harness";
import { describe, expect, it } from "vitest";
import { SAMPLE_CATALOG } from "./catalog";
import { buildMovieParserConfig, MOVIE_ROUTER_OPTIONS } from "./config";
import { filterMovies } from "./filter";

const config = buildMovieParserConfig(SAMPLE_CATALOG);
const chipsOf = (q: string) => parse(q, config).chips.map((c) => `${c.negate ? "!" : ""}${c.kind}:${c.label}`);
const titlesOf = (q: string) => filterMovies(SAMPLE_CATALOG, parse(q, config).chips, new Set()).movies.map((m) => m.title);
const routeOf = (q: string) => decideRoute(parse(q, config), MOVIE_ROUTER_OPTIONS).route;

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
    expect(titlesOf("like inception but not sci-fi, under 2 hours")).toEqual(["John Wick", "Get Out", "Righteous Kill"]);
  });

  it("sends a group task to the assistant", () => {
    expect(routeOf("plan a movie night for me and a friend who hates horror")).toBe("assistant");
  });

  it("hides watched movies", () => {
    const heat = SAMPLE_CATALOG.find((m) => m.title === "Heat")!;
    const r = filterMovies(SAMPLE_CATALOG, parse("pacino crime", config).chips, new Set([heat.id]));
    expect(r.movies.map((m) => m.title)).not.toContain("Heat");
    expect(r.hiddenWatched).toBe(1);
  });
});
