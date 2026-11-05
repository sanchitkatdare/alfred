import { describe, expect, it } from "vitest";
import { answerPicks } from "./AssistantPanel";

const found = [
  { id: 1, title: "Heat" },
  { id: 2, title: "Up" },
  { id: 3, title: "Thief" },
  { id: 4, title: "Ronin" },
];

describe("answerPicks", () => {
  it("keeps the movies the answer names, in answer order", () => {
    expect(answerPicks("Try **Ronin** (1998), then Heat (1995).", found)).toEqual([4, 1]);
  });

  it("matches whole titles with the same case only", () => {
    expect(answerPicks("Things heat up in Heatwave. Thieves everywhere.", found)).toEqual([]);
    expect(answerPicks("Up (2009) is a short one.", found)).toEqual([2]);
  });

  it("returns nothing when the answer names no found movie", () => {
    expect(answerPicks("I could not find a match.", found)).toEqual([]);
  });
});
