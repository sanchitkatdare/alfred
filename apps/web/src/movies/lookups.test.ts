import { describe, expect, it } from "vitest";
import { answerFromCatalog, buildTitleIndex, detectLookup } from "./lookups";
import { SAMPLE_CATALOG } from "./sample-catalog.fixture";

const remake = { ...SAMPLE_CATALOG.find((m) => m.title === "Heat")!, id: 9001, year: 1986 }; // no votes, like the sample
const index = buildTitleIndex([...SAMPLE_CATALOG, remake]);
const detect = (q: string) => {
  const l = detectLookup(q, index);
  return l ? `${l.kind}:${l.movie?.title ?? ""}${l.movie ? ` ${l.movie.year}` : ""}` : null;
};

describe("titles that look like something else", () => {
  const base = SAMPLE_CATALOG[0]!;
  const movies = [
    { ...base, id: 1, title: "Blade Runner", year: 1982, votes: 100 },
    { ...base, id: 2, title: "Blade Runner 2049", year: 2017, votes: 50 },
    { ...base, id: 3, title: "1917", year: 2019, votes: 50 },
    { ...base, id: 4, title: "Heat", year: 1995, votes: 50 },
    { ...base, id: 5, title: "Heat", year: 1986, votes: 5 },
    { ...base, id: 6, title: "Spirited Away", originalTitle: "千と千尋の神隠し", year: 2001, votes: 50 },
    { ...base, id: 7, title: "Project A", originalTitle: "A計劃", year: 1983, votes: 50 },
    { ...base, id: 8, title: "Amelie", originalTitle: "Le Fabuleux Destin d'Amélie Poulain", year: 2001, votes: 50 },
  ];
  const titles = buildTitleIndex(movies);
  const find = (q: string) => {
    const l = detectLookup(q, titles);
    return l?.movie ? `${l.movie.title} ${l.movie.year}` : null;
  };

  it.each([
    ["who directed blade runner 2049", "Blade Runner 2049 2017"],
    ["how long is 1917", "1917 2019"],
    ["who directed blade runner", "Blade Runner 1982"],
    ["who directed heat 1986", "Heat 1986"],
    ["who directed le fabuleux destin d'amelie poulain", "Amelie 2001"],
  ])("%s", (q, expected) => {
    expect(find(q)).toBe(expected);
  });

  it.each(["who directed 千と千尋の神隠し", "who directed -", "how long is 2012", "who directed a"])("finds no movie: %s", (q) => {
    expect(find(q)).toBeNull();
  });

  it("indexes no empty key", () => {
    expect(titles.byKey.has("")).toBe(false);
  });
});

describe("detectLookup", () => {
  it.each(["what is it about", "how long is it", "who directed them", "tell me about her", "who is in that one"])("does not read a pronoun as a title: %s", (q) => {
    expect(detect(q)).toBeNull();
  });


  it.each([
    ["Who directed Inception?", "director:Inception 2010"],
    ["who is the director of the dark knight", "director:The Dark Knight 2008"],
    ["Who stars in Heat?", "cast:Heat 1995"],
    ["cast of the matrix", "cast:The Matrix 1999"],
    ["How long is The Irishman?", "runtime:The Irishman 2019"],
    ["when did taxi driver come out", "year:Taxi Driver 1976"],
    ["what year is scarface from?", "year:Scarface 1983"],
    ["What's Inception rated?", "rating:Inception 2010"],
    ["what genre is arrival", "genre:Arrival 2016"],
    ["What is Memento about?", null],
    ["what is arrival about", "about:Arrival 2016"],
    ["tell me about the movie prisoners", "about:Prisoners 2013"],
    ["Mark The Dark Knight as watched", null],
    ["What have I watched so far?", "watched-list: "],
  ])("%s", (q, expected) => {
    expect(detect(q)?.trim() ?? null).toBe(expected?.trim() ?? null);
  });

  it("picks a remake by year and lists the other version", () => {
    expect(detect("how long is heat (1986)")).toBe("runtime:Heat 1986");
    expect(detectLookup("how long is heat", index)!.others.map((m) => m.year)).toEqual([1986]);
  });

  it.each([
    "who directed inception and is it worth watching",
    "who directed a movie about dreams",
    "how long is a typical comedy",
    "is heat worth watching",
  ])("leaves %s to the assistant or search", (q) => {
    expect(detect(q)).toBeNull();
  });
});

describe("answerFromCatalog", () => {
  const ask = (q: string) => answerFromCatalog(detectLookup(q, index)!);
  it("answers from the movie's data", () => {
    expect(ask("who directed the matrix")).toBe("The Matrix (1999) was directed by Lana Wachowski and Lilly Wachowski.");
    expect(ask("how long is inception")).toBe("Inception (2010) runs 2 h 28 min (148 minutes).");
    expect(ask("who stars in heat")).toBe("Heat (1995) stars Al Pacino, Robert De Niro and Val Kilmer (top-billed cast).");
  });
});
