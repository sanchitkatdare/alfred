import { describe, expect, it } from "vitest";
import { buildDictionary, decideRoute, DEFAULT_STOP_WORDS, DEFAULT_TASK_PHRASES, parse, type ParserConfig } from "../src";

const dictionary = buildDictionary({
  terms: [
    { kind: "genre", id: "sci-fi", label: "Sci-fi", aliases: ["scifi", "science fiction"] },
    { kind: "genre", id: "horror", label: "Horror", aliases: ["scary"] },
    { kind: "genre", id: "comedy", label: "Comedy" },
    { kind: "genre", id: "crime", label: "Crime" },
  ],
  people: [
    { kind: "actor", name: "Robert De Niro", count: 6 },
    { kind: "actor", name: "Al Pacino", count: 5 },
    { kind: "actor", name: "Jennifer Lawrence", count: 8 },
    { kind: "director", name: "Francis Lawrence", count: 2 },
    { kind: "actor", name: "Chris Hemsworth", count: 2 },
    { kind: "actor", name: "Liam Hemsworth", count: 2 },
    { kind: "actor", name: "Emma Stone", count: 2 },
  ],
  commonWords: ["stone"],
});

const config: ParserConfig = {
  dictionary,
  stopWords: [...DEFAULT_STOP_WORDS, "movie", "movies", "film"],
  phrases: [
    ...DEFAULT_TASK_PHRASES,
    { phrase: ["havent", "seen"], chip: { kind: "user", id: "unwatched", label: "Unwatched only" } },
    { phrase: ["not", "seen"], chip: { kind: "user", id: "unwatched", label: "Unwatched only" } },
  ],
};

const chipsOf = (q: string) => parse(q, config).chips.map((c) => `${c.negate ? "!" : ""}${c.kind}:${c.id}`);

describe("dictionary matching", () => {
  it("matches full names, aliases and multi-word terms", () => {
    expect(chipsOf("a jennifer lawrence science fiction movie")).toEqual(["actor:Jennifer Lawrence", "genre:sci-fi"]);
  });

  it("ignores spacing and case in names", () => {
    expect(chipsOf("movie with deNiro and pacino")).toEqual(["actor:Robert De Niro", "actor:Al Pacino"]);
  });

  it("resolves a surname to the dominant person and lists the others", () => {
    const chip = parse("lawrence", config).chips[0]!;
    expect(chip.id).toBe("Jennifer Lawrence");
    expect(chip.ambiguous).toBe(false);
    expect(chip.alts).toEqual(["Francis Lawrence"]);
  });

  it("flags a surname shared by people with similar counts", () => {
    const chip = parse("hemsworth", config).chips[0]!;
    expect(chip.ambiguous).toBe(true);
    expect(chip.alts).toHaveLength(1);
  });

  it("does not match a common-word surname alone", () => {
    const r = parse("stone age", config);
    expect(r.chips).toEqual([]);
    expect(r.leftover).toEqual(["stone", "age"]);
    expect(chipsOf("emma stone comedy")).toEqual(["actor:Emma Stone", "genre:comedy"]);
  });

  it("tolerates typos", () => {
    const chip = parse("jenifer lawrance", config).chips[0]!;
    expect(chip.id).toBe("Jennifer Lawrence");
    expect(chip.fuzzy).toBe(true);
  });

  it("suggests a full name for a trailing first name", () => {
    expect(parse("a crime movie with jennifer", config).suggestion).toEqual({ from: "jennifer", to: "Jennifer Lawrence" });
  });
});

describe("negation", () => {
  it.each([
    ["not scary", ["!genre:horror"]],
    ["without pacino", ["!actor:Al Pacino"]],
    ["crime that does not have horror", ["genre:crime", "!genre:horror"]],
    ["doesn't have de niro", ["!actor:Robert De Niro"]],
    ["anything but comedy or horror", ["!genre:comedy", "!genre:horror"]],
    ["non-horror comedy", ["!genre:horror", "genre:comedy"]],
  ])("%s", (q, expected) => {
    expect(chipsOf(q)).toEqual(expected);
  });

  it("ends after a word that is not a connector", () => {
    expect(chipsOf("not horror with pacino")).toEqual(["!genre:horror", "actor:Al Pacino"]);
  });

  it("skips stop words before the first entity", () => {
    expect(chipsOf("not a horror movie")).toEqual(["!genre:horror"]);
  });

  it("prefers a phrase chip over negation", () => {
    expect(chipsOf("sci-fi i have not seen")).toEqual(["genre:sci-fi", "user:unwatched"]);
  });
});

describe("decideRoute", () => {
  const routeOf = (q: string) => decideRoute(parse(q, config), { semanticKinds: ["similar"] }).route;

  it("routes fully matched queries to local filtering", () => {
    expect(routeOf("de niro crime")).toBe("local");
  });

  it("routes free text to semantic search", () => {
    expect(routeOf("mind-bending sci-fi")).toBe("semantic");
  });

  it("routes tasks to the assistant", () => {
    expect(routeOf("plan a crime movie marathon")).toBe("assistant");
  });

  it("returns empty for stop words only", () => {
    expect(routeOf("a movie")).toBe("empty");
  });
});
