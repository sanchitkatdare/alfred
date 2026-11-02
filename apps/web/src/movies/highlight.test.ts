import { parse } from "@alfred/agent-harness";
import { describe, expect, it } from "vitest";
import { SAMPLE_CATALOG } from "./sample-catalog.fixture";
import { buildMovieParserConfig } from "./config";
import { wordSegments } from "./highlight";

const config = buildMovieParserConfig(SAMPLE_CATALOG);
const marked = (q: string) => wordSegments(q, parse(q, config)).filter((s) => s.sig).map((s) => s.text);

describe("wordSegments", () => {
  it("keeps the typed text, including capitals and punctuation", () => {
    const q = "Comedy, UNDER 2 hours about dreams!";
    expect(wordSegments(q, parse(q, config)).map((s) => s.text).join("")).toBe(q);
  });

  it("marks the words that produced a chip", () => {
    expect(marked("comedy under 2 hours about dreams")).toEqual(["comedy", "under 2 hours"]);
  });

  it("does not mark a comma after a term", () => {
    expect(marked("comedy, dreams")).toEqual(["comedy"]);
  });

  it("leaves the text whole when no offsets can be mapped", () => {
    const decomposed = "Ame\u0301lie comedy";
    expect(wordSegments(decomposed, parse(decomposed, config))).toEqual([{ text: decomposed }]);
  });
});
