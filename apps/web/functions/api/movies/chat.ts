import { chatRequestSchema, runMovieChat } from "../../../server/chat";
import type { Env } from "../../../server/env";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const parsed = chatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request", details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }
  try {
    const { message, usage, timings, serverTiming } = await runMovieChat(env, parsed.data.messages);
    return Response.json({ message, usage, timings }, { headers: { "Server-Timing": serverTiming } });
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    // Workers AI errors when the daily free allocation is used up. AI Gateway errors when its rate limit is hit.
    return Response.json({ error: `The assistant is unavailable: ${text}` }, { status: 502 });
  }
};
