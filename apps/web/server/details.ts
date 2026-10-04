import type { MovieStory } from "../src/movies/tools";
import type { Env } from "./env";
import { getVectorsByIds } from "./vectorize";

/** Story text stored as Vectorize metadata by scripts/seed.ts. */
export async function getMovieStories(env: Env, ids: number[]): Promise<MovieStory[]> {
  const vectors = await getVectorsByIds(env.VECTORIZE_MOVIES, ids);
  return vectors.map((v) => {
    const m = (v.metadata ?? {}) as Record<string, unknown>;
    const text = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : "");
    return { id: Number(v.id), overview: text("overview"), tagline: text("tagline"), keywords: text("keywords") };
  });
}
