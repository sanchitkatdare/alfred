import type { Chip } from "@alfred/agent-harness";
import { describe, expect, it } from "vitest";
import { searchKey } from "./useSemanticSearch";

const chip = (sig: string) => ({ sig }) as Chip;

describe("searchKey", () => {
  it("changes when a chip is removed", () => {
    expect(searchKey("q", [chip("a")])).not.toBe(searchKey("q", []));
  });

  it("stays the same for the same text and chips", () => {
    expect(searchKey("q", [chip("a")])).toBe(searchKey("q", [chip("a")]));
  });
});
