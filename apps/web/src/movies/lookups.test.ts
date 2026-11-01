import { describe, expect, it } from "vitest";
import { answerFromCatalog, buildTitleIndex, detectLookup } from "./lookups";
import { SAMPLE_CATALOG } from "./sample-catalog.fixture";

const remake = { ...SAMPLE_CATALOG.find((m) => m.title === "Heat")!, id: 9001, year: 1986 }; // no votes, like the sample
const index = buildTitleIndex([...SAMPLE_CATALOG, remake]);
const detect = (q: string) => {
  const l = detectLookup(q, index);
  return l ? `${l.kind}:${l.movie?.title ?? ""}${l.movie ? ` ${l.movie.year}` : ""}` : null;
};

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
