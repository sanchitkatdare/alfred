import { CHAT_TIER_MODELS, CHAT_TIER_TIMEOUT_MS, chatRequestSchema, runMovieChat } from "../../../server/chat";
import type { Env } from "../../../server/env";
import { readJsonBody } from "../../../server/http";
import { TimeoutError } from "../../../server/timing";
import { MODEL_TOO_SLOW } from "../../../src/movies/assistant";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = chatRequestSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "Invalid request", details: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  try {
    const { message, usage, model } = await runMovieChat(env, parsed.data.messages, { model: CHAT_TIER_MODELS[parsed.data.tier], timeoutMs: CHAT_TIER_TIMEOUT_MS[parsed.data.tier] });
    return Response.json({ message, usage, model });
  } catch (e) {
    if (e instanceof TimeoutError) return Response.json({ error: MODEL_TOO_SLOW }, { status: 504 });
    // Details stay in the server log. Common causes: daily Workers AI allocation used up, AI Gateway rate limit.
    console.error("chat failed", e);
    return Response.json({ error: "The assistant is unavailable right now. Search and filters still work." }, { status: 502 });
  }
};
