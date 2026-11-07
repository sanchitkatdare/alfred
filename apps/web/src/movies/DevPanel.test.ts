import { describe, expect, it } from "vitest";
import { describeHints } from "./DevPanel";

describe("describeHints", () => {
  it("writes filters in plain words", () => {
    expect(describeHints({ languages: ["hi"], genres: ["drama", "romance"], maxRuntime: 120 })).toBe("languages: hi · genres: drama, romance · maxRuntime: 120");
    expect(describeHints({})).toBe("");
  });
});
