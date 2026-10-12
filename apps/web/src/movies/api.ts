/** Calls to our Pages Functions. Error messages from the server are shown to the user as they are. */

async function post<T>(path: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? `Request failed (HTTP ${res.status})`);
  return data;
}

const EMBED_CACHE_SIZE = 50;

/**
 * Turns query text into a vector via /api/movies/embed. Keeps the 50 most recent queries, so repeating
 * a search costs no server call. Failed requests are not cached.
 */
export interface EmbedReport {
  text: string;
  cached: boolean;
  ms: number;
  /** Estimated by the server; absent for cached vectors. */
  neurons?: number;
}

export function createEmbedClient(fetchImpl: typeof fetch = (...args) => fetch(...args), onResult?: (report: EmbedReport) => void) {
  const cache = new Map<string, Promise<number[]>>();
  const neuronsOf = new WeakMap<Promise<number[]>, number>();
  return (text: string): Promise<number[]> => {
    const key = text.trim().toLowerCase();
    const started = performance.now();
    let vector = cache.get(key);
    const cached = !!vector;
    if (vector) {
      cache.delete(key); // move to the newest position
    } else {
      const request = post<{ vector: number[]; usage?: { neurons: number } }>("/api/movies/embed", { text }, fetchImpl);
      vector = request.then((r) => r.vector);
      const v = vector;
      request.then((r) => r.usage && neuronsOf.set(v, r.usage.neurons)).catch(() => {});
      vector.catch(() => cache.delete(key));
    }
    const v = vector;
    v.then(() => onResult?.({ text, cached, ms: Math.round(performance.now() - started), ...(cached ? {} : { neurons: neuronsOf.get(v) }) })).catch(() => {});
    cache.set(key, vector);
    if (cache.size > EMBED_CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return vector;
  };
}

/**
 * Turns low-level errors into a message for the page. Our Functions send readable errors;
 * an empty 502 or a network failure means the API server was not reached at all.
 */
export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|load failed|HTTP 50[234]|status 50[234]/i.test(message)) {
    return import.meta.env.DEV
      ? "Can't reach the API server. Start it with `pnpm dev`, which runs the page and the API together."
      : "Can't reach the server right now. Filters still work.";
  }
  return message.replace(/^LLM provider "[^"]*" failed: /, "");
}
