import { z } from "zod";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, type Env } from "./env";
import { createTimer } from "./timing";

export const embedRequestSchema = z.object({ text: z.string().trim().min(1).max(200) });

export interface EmbedResponse {
  /** 384 numbers, rounded to 5 decimals. The browser ranks movies against it. */
  vector: number[];
  timings: Record<string, number>;
}

/** Turns a search query into a vector with the same model that embedded the catalog. */
export async function embedQuery(env: Env, text: string): Promise<{ body: EmbedResponse; serverTiming: string }> {
  const timer = createTimer();
  const out = (await timer.step("embed", () => env.AI.run(EMBEDDING_MODEL, { text: [text] }))) as { data: number[][] };
  const vector = out.data[0];
  if (vector?.length !== EMBEDDING_DIMENSIONS) throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${vector?.length}`);
  return { body: { vector: vector.map((x) => Math.round(x * 1e5) / 1e5), timings: timer.steps() }, serverTiming: timer.header() };
}
