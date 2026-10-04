import { parse } from "@alfred/agent-harness";
import { describe, expect, it } from "vitest";
import { SAMPLE_CATALOG } from "./catalog";
import { buildMovieParserConfig } from "./config";
import { chipsToSearchHints, mergeSearchHints } from "./hints";
import type { SearchArgs } from "./tools";

const config = buildMovieParserConfig(SAMPLE_CATALOG);
const hintsOf = (q: string) => chipsToSearchHints(parse(q, config).chips);

describe("chipsToSearchHints", () => {
  it.each([
    ["A good 90s thriller", { genres: ["thriller"], yearFrom: 1990, yearTo: 1999 }],
    ["a friend who hates horror, rated above 7", { excludeGenres: ["horror"], minRating: 7 }],
    ["a crime movie without Al Pacino", { genres: ["crime"], excludePeople: ["Al Pacino"] }],
    ["comedy under 2 hours", { genres: ["comedy"], maxRuntime: 120 }],
    ["plan a movie night like inception", {}],
  ])("%s", (q, expected) => {
    expect(hintsOf(q)).toEqual(expected);
  });
});

describe("mergeSearchHints", () => {
  it("adds missing filters and keeps the model's query", () => {
    expect(mergeSearchHints<SearchArgs>({ query: "90s thriller", limit: 5 }, { genres: ["thriller"], yearFrom: 1990, yearTo: 1999 }))
      .toEqual({ query: "90s thriller", limit: 5, genres: ["thriller"], yearFrom: 1990, yearTo: 1999 });
  });

  it("lets the user's exclusion win over a model's inclusion", () => {
    expect(mergeSearchHints({ genres: ["horror", "comedy"] }, { excludeGenres: ["horror"] }))
      .toEqual({ genres: ["comedy"], excludeGenres: ["horror"] });
  });

  it("uses hint numbers over model numbers", () => {
    expect(mergeSearchHints({ minRating: 6 }, { minRating: 7 })).toEqual({ minRating: 7 });
  });
});
