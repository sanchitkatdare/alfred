import type { LLMProvider, LLMResponse } from "../agent";

/**
 * Browser-side provider that calls our own chat endpoint. The server owns the model,
 * the system prompt and the tool list, so only the conversation is sent.
 */
export function createHttpProvider(url: string, options: { name?: string; fetch?: typeof fetch } = {}): LLMProvider {
  const doFetch = options.fetch ?? fetch;
  return {
    name: options.name ?? `http:${url}`,
    async complete({ messages, signal }) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: messages.filter((m) => m.role !== "system") }),
        signal,
      });
      const body = (await res.json().catch(() => null)) as (LLMResponse & { error?: string; message?: unknown }) | null;
      if (!res.ok || !body?.message || typeof body.message !== "object") {
        throw new Error(body?.error ?? `Chat request failed with status ${res.status}`);
      }
      return { message: body.message, usage: body.usage };
    },
  };
}
