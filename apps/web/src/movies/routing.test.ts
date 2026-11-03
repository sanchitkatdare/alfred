import { describe, expect, it } from "vitest";
import { decideAppRoute, startsNewSearch, type AppRouteInput } from "./routing";
import { SAMPLE_CATALOG } from "./sample-catalog.fixture";

const input = (change: Partial<AppRouteInput>): AppRouteInput => ({
  query: "which of those is shortest",
  lookup: null,
  rules: { route: "semantic", reason: "Free text remains" },
  inConversation: true,
  ignoreFollowUp: false,
  ...change,
});

describe("startsNewSearch", () => {
  it("starts over for unrelated text, also when it is a task", () => {
    expect(startsNewSearch("dream heist", false)).toBe(true);
    expect(startsNewSearch("plan a movie night", false)).toBe(true);
  });

  it("keeps the conversation when the text refers back", () => {
    expect(startsNewSearch("compare those two", false)).toBe(false);
  });

  it("starts over when the follow-up chip was removed", () => {
    expect(startsNewSearch("compare those two", true)).toBe(true);
  });
});

describe("decideAppRoute", () => {
  const lookup = { kind: "director" as const, movie: SAMPLE_CATALOG[0]!, others: [] };

  it("answers a lookup before anything else", () => {
    expect(decideAppRoute(input({ lookup, rules: { route: "assistant", reason: "x" } }))).toMatchObject({ route: "lookup", followUp: false });
  });

  it("sends a reference to an earlier answer to the assistant", () => {
    expect(decideAppRoute(input({}))).toMatchObject({ route: "assistant", followUp: true });
  });

  it("needs a finished conversation for a follow-up", () => {
    expect(decideAppRoute(input({ inConversation: false }))).toMatchObject({ route: "semantic", followUp: false });
  });

  it("respects a removed follow-up chip", () => {
    expect(decideAppRoute(input({ ignoreFollowUp: true }))).toMatchObject({ route: "semantic", followUp: false });
  });

  it("does not mark a task as a follow-up", () => {
    expect(decideAppRoute(input({ rules: { route: "assistant", reason: "Task requested" } }))).toEqual({ route: "assistant", reason: "Task requested", followUp: false });
  });

  it("uses the rules when nothing refers back", () => {
    expect(decideAppRoute(input({ query: "dream heist" }))).toMatchObject({ route: "semantic", followUp: false });
  });
});
