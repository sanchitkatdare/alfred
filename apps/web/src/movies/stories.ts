import type { MovieStory } from "./tools";

/**
 * Story text (overview, tagline, keywords) for get_movie_details, stored as static files:
 * public/data/stories/<id % 64>.json. The browser fetches only the files it needs.
 */
export const STORY_SHARDS = 64;
export const storyShardOf = (id: number) => id % STORY_SHARDS;
export const storyShardPath = (shard: number) => `data/stories/${shard}.json`;

export type StoryShard = Record<string, Omit<MovieStory, "id">>;

/** Loads stories by id, fetching each shard at most once. A failed fetch is not cached, so the next call retries. */
export function createStoryLoader(fetchShard: (path: string) => Promise<StoryShard>) {
  const shards = new Map<number, Promise<StoryShard>>();
  return async (ids: number[]): Promise<MovieStory[]> => {
    const results = await Promise.all(ids.map(async (id) => {
      const shard = storyShardOf(id);
      if (!shards.has(shard)) {
        const request = fetchShard(storyShardPath(shard));
        shards.set(shard, request);
        request.catch(() => shards.delete(shard));
      }
      const story = (await shards.get(shard)!)[id];
      return story ? { id, ...story } : null;
    }));
    return results.filter((s): s is MovieStory => !!s);
  };
}
