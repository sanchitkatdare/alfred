import type { MovieStory } from "../src/movies/tools";
import type { Env } from "./env";

const GET_BY_IDS_CHUNK = 20;

/** Story text stored as Vectorize metadata by scripts/seed.ts. */
export async function getMovieStories(env: Env, ids: number[]): Promise<MovieStory[]> {
  const keys = ids.map(String);
  const chunks = Array.from({ length: Math.ceil(keys.length / GET_BY_IDS_CHUNK) }, (_, i) => keys.slice(i * GET_BY_IDS_CHUNK, (i + 1) * GET_BY_IDS_CHUNK));
  const vectors = (await Promise.all(chunks.map((c) => env.VECTORIZE_MOVIES.getByIds(c)))).flat();
  return vectors.map((v) => {
    const m = (v.metadata ?? {}) as Record<string, unknown>;
    const text = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : "");
    return { id: Number(v.id), overview: text("overview"), tagline: text("tagline"), keywords: text("keywords") };
  });
}
