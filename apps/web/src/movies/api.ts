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
export function createEmbedClient(fetchImpl: typeof fetch = (...args) => fetch(...args)) {
  const cache = new Map<string, Promise<number[]>>();
  return (text: string): Promise<number[]> => {
    const key = text.trim().toLowerCase();
    let vector = cache.get(key);
    if (vector) {
      cache.delete(key); // move to the newest position
    } else {
      vector = post<{ vector: number[] }>("/api/movies/embed", { text }, fetchImpl).then((r) => r.vector);
      vector.catch(() => cache.delete(key));
    }
    cache.set(key, vector);
    if (cache.size > EMBED_CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return vector;
  };
}
