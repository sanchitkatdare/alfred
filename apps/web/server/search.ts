import { z } from "zod";
import { EMBEDDING_MODEL, type Env } from "./env";
import { createTimer } from "./timing";
import { getVectorsByIds } from "./vectorize";

export const searchRequestSchema = z.object({
  text: z.string().trim().min(1).max(200),
  /**
   * Candidate IDs from the browser's local filters. When present, only these are ranked.
   * Use this when filters (actor, genre) leave a small set that a top-100 query could miss.
   */
  ids: z.array(z.number().int().positive()).min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;

export interface SearchResponse {
  mode: "query" | "candidates";
  results: { id: number; score: number }[];
  timings: Record<string, number>;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export async function embedTexts(ai: Ai, texts: string[]): Promise<number[][]> {
  const out = (await ai.run(EMBEDDING_MODEL, { text: texts })) as { data: number[][] };
  return out.data;
}

export async function searchMovies(env: Env, req: SearchRequest): Promise<{ body: SearchResponse; serverTiming: string }> {
  const timer = createTimer();
  const [vector] = await timer.step("embed", () => embedTexts(env.AI, [req.text]));

  let results: SearchResponse["results"];
  if (req.ids) {
    const ids = req.ids;
    const vectors = await timer.step("vectorize", () => getVectorsByIds(env.VECTORIZE_MOVIES, ids));
    results = vectors
      .map((v) => ({ id: Number(v.id), score: cosine(vector!, v.values as ArrayLike<number>) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, req.limit);
  } else {
    const found = await timer.step("vectorize", () => env.VECTORIZE_MOVIES.query(vector!, { topK: req.limit, returnMetadata: "none" }));
    results = found.matches.map((m) => ({ id: Number(m.id), score: m.score }));
  }

  return {
    body: { mode: req.ids ? "candidates" : "query", results, timings: timer.steps() },
    serverTiming: timer.header(),
  };
}
