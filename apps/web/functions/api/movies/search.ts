import type { Env } from "../../../server/env";
import { searchMovies, searchRequestSchema } from "../../../server/search";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const started = Date.now();
  const parsed = searchRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request", details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }
  try {
    const { body, serverTiming } = await searchMovies(env, parsed.data);
    return Response.json(body, { headers: { "Server-Timing": `${serverTiming}, total;dur=${Date.now() - started}` } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Workers AI returns an error when the daily free allocation is used up.
    return Response.json({ error: "Search failed", message }, { status: 502 });
  }
};
