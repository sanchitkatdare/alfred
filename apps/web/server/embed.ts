import { z } from "zod";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, type Env } from "./env";
import { createTimer, withTimeout } from "./timing";

export const EMBED_TIMEOUT_MS = 10_000;
/** Workers AI pricing page (2026-10-01): bge-small-en-v1.5 input. Embedding responses report tokens, not neurons. */
const NEURONS_PER_MILLION_TOKENS = 1_841;

export const embedRequestSchema = z.object({ text: z.string().trim().min(1).max(200) });

export interface EmbedResponse {
  /** 384 numbers, rounded to 5 decimals. The browser ranks movies against it. */
  vector: number[];
  /** `neurons` is estimated from tokens. */
  usage?: { tokens: number; neurons: number };
  timings: Record<string, number>;
}

/** Turns a search query into a vector with the same model that embedded the catalog. */
export async function embedQuery(env: Env, text: string): Promise<{ body: EmbedResponse; serverTiming: string }> {
  const timer = createTimer();
  const out = (await timer.step("embed", () => withTimeout(env.AI.run(EMBEDDING_MODEL, { text: [text] }), EMBED_TIMEOUT_MS, "Embedding"))) as { data: number[][]; usage?: { prompt_tokens?: number } };
  const vector = out.data[0];
  if (vector?.length !== EMBEDDING_DIMENSIONS) throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${vector?.length}`);
  const tokens = out.usage?.prompt_tokens;
  const usage = tokens === undefined ? undefined : { tokens, neurons: (tokens * NEURONS_PER_MILLION_TOKENS) / 1e6 };
  return { body: { vector: vector.map((x) => Math.round(x * 1e5) / 1e5), ...(usage ? { usage } : {}), timings: timer.steps() }, serverTiming: timer.header() };
}
