import { describe, expect, it } from "vitest";
import { isFollowUp } from "./followups";

describe("isFollowUp", () => {
  it.each(["which of those is the shortest?", "something lighter instead", "is the first one on netflix", "Tell me more about it", "any others like that?", "the other one"])(
    "%s refers back",
    (q) => expect(isFollowUp(q)).toBe(true),
  );

  it.each(["a 90s crime movie", "mind-bending dream heist", "movie with pacino"])("%s does not", (q) => expect(isFollowUp(q)).toBe(false));
});
