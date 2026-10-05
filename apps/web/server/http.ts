/** Request limits for the public API. A modified client can send anything, so these are the real limits. */
export const LIMITS = {
  bodyBytes: 64 * 1024,
  userMessageChars: 300,
  assistantMessageChars: 2_000,
  toolMessageChars: 4_000,
  conversationChars: 24_000,
  messages: 30,
} as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Checks every /api request before it reaches an endpoint. Returns a response to reject, or null to continue.
 * Browsers always send Origin on POST, so a missing or foreign Origin means another site or a script.
 */
export function guardApiRequest(request: Request): Response | null {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const origin = request.headers.get("Origin");
  const target = new URL(request.url);
  let from: URL | null = null;
  try {
    from = origin ? new URL(origin) : null;
  } catch {
    from = null;
  }
  const sameSite = from && (from.host === target.host || (LOCAL_HOSTS.has(from.hostname) && LOCAL_HOSTS.has(target.hostname)));
  if (!sameSite) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (Number(request.headers.get("Content-Length") ?? 0) > LIMITS.bodyBytes) return Response.json({ error: "Request too large" }, { status: 413 });
  return null;
}

/** Reads a JSON body with a size limit, also when no Content-Length header was sent. */
export async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > LIMITS.bodyBytes) return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
}
