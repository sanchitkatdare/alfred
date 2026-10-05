import { chatRequestSchema, runMovieChat } from "../../../server/chat";
import type { Env } from "../../../server/env";
import { readJsonBody } from "../../../server/http";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = chatRequestSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "Invalid request", details: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  try {
    const { message, usage, timings, serverTiming } = await runMovieChat(env, parsed.data.messages);
    return Response.json({ message, usage, timings }, { headers: { "Server-Timing": serverTiming } });
  } catch (e) {
    // Details stay in the server log. Common causes: daily Workers AI allocation used up, AI Gateway rate limit.
    console.error("chat failed", e);
    return Response.json({ error: "The assistant is unavailable right now. Search and filters still work." }, { status: 502 });
  }
};
