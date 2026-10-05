import { describe, expect, it } from "vitest";
import { trimHistory, type ChatMessage } from "../src";

const turn = (q: string, answer: string): ChatMessage[] => [
  { role: "user", content: q },
  { role: "assistant", content: "", toolCalls: [{ id: `c-${q}`, name: "search_movies", arguments: { query: q } }] },
  { role: "tool", toolCallId: `c-${q}`, content: "x".repeat(100) },
  { role: "assistant", content: answer },
];

describe("trimHistory", () => {
  it("keeps everything that fits", () => {
    const h = [...turn("a", "A"), ...turn("b", "B")];
    expect(trimHistory(h, 10_000)).toEqual(h);
  });

  it("drops the oldest whole turns first", () => {
    const h = [...turn("first", "1"), ...turn("second", "2"), ...turn("third", "3")];
    const kept = trimHistory(h, 400);
    expect(kept[0]).toEqual({ role: "user", content: "second" });
    expect(kept.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["second", "third"]);
  });

  it("returns nothing when the latest turn alone is too big, and drops system messages", () => {
    expect(trimHistory([{ role: "system", content: "s" }, ...turn("a", "A")], 10)).toEqual([]);
    expect(trimHistory([{ role: "system", content: "s" }, { role: "user", content: "hi" }], 100)).toEqual([{ role: "user", content: "hi" }]);
  });
});
