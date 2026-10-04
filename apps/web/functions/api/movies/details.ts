import { z } from "zod";
import { getMovieStories } from "../../../server/details";
import type { Env } from "../../../server/env";

const schema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(10) });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    return Response.json({ stories: await getMovieStories(env, parsed.data.ids) });
  } catch (e) {
    return Response.json({ error: "Details failed", message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
};
