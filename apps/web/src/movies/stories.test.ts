import { describe, expect, it } from "vitest";
import { createStoryLoader, storyShardPath } from "./stories";

describe("story loader", () => {
  it("fetches each shard once and returns stories by id", async () => {
    const fetched: string[] = [];
    const load = createStoryLoader(async (path) => {
      fetched.push(path);
      return { 77: { overview: "Memory loss.", tagline: "", keywords: "amnesia" }, 141: { overview: "Other.", tagline: "", keywords: "" } };
    });
    const stories = await load([77, 141, 999]);
    expect(stories.map((s) => s.id)).toEqual([77, 141]);
    // 77 and 141 share shard 13; 999 is in shard 39 and has no story.
    expect(fetched).toEqual([storyShardPath(13), storyShardPath(39)]);
  });
});
