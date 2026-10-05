import { embedQuery, embedRequestSchema } from "../../../server/embed";
import type { Env } from "../../../server/env";
import { readJsonBody } from "../../../server/http";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = embedRequestSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    const { body: result, serverTiming } = await embedQuery(env, parsed.data.text);
    return Response.json(result, { headers: { "Server-Timing": serverTiming } });
  } catch (e) {
    // Details stay in the server log. Common cause: daily Workers AI allocation used up.
    console.error("embed failed", e);
    return Response.json({ error: "Search is unavailable right now. Filters still work." }, { status: 502 });
  }
};
