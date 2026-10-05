import type { MovieStory } from "./tools";

/**
 * Story text (overview, tagline, keywords) for get_movie_details, stored as static files:
 * public/data/stories/<id % 64>.json. The browser fetches only the files it needs.
 */
export const STORY_SHARDS = 64;
export const storyShardOf = (id: number) => id % STORY_SHARDS;
export const storyShardPath = (shard: number) => `data/stories/${shard}.json`;

export type StoryShard = Record<string, Omit<MovieStory, "id">>;

/** Loads stories by id, fetching each shard at most once. */
export function createStoryLoader(fetchShard: (path: string) => Promise<StoryShard>) {
  const shards = new Map<number, Promise<StoryShard>>();
  return async (ids: number[]): Promise<MovieStory[]> => {
    const results = await Promise.all(ids.map(async (id) => {
      const shard = storyShardOf(id);
      if (!shards.has(shard)) shards.set(shard, fetchShard(storyShardPath(shard)));
      const story = (await shards.get(shard)!)[id];
      return story ? { id, ...story } : null;
    }));
    return results.filter((s): s is MovieStory => !!s);
  };
}
