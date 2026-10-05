import { describe, expect, it } from "vitest";
import { createEmbedClient } from "./api";

function fakeServer(fail = 0) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const { text } = JSON.parse(String(init!.body));
    calls.push(text);
    if (calls.length <= fail) return new Response(JSON.stringify({ error: "Search is unavailable right now. Filters still work." }), { status: 502 });
    return new Response(JSON.stringify({ vector: [calls.length, 0, 0] }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("embed client", () => {
  it("reuses the vector for a repeated query, ignoring case and spaces", async () => {
    const { calls, fetchImpl } = fakeServer();
    const embed = createEmbedClient(fetchImpl);
    await embed("Dream heist");
    await embed("  dream heist ");
    expect(calls).toEqual(["Dream heist"]);
  });

  it("shows the server's error and retries after a failure", async () => {
    const { calls, fetchImpl } = fakeServer(1);
    const embed = createEmbedClient(fetchImpl);
    await expect(embed("x")).rejects.toThrow("Search is unavailable right now. Filters still work.");
    await expect(embed("x")).resolves.toEqual([2, 0, 0]);
    expect(calls).toHaveLength(2);
  });

  it("keeps only the 50 most recent queries", async () => {
    const { calls, fetchImpl } = fakeServer();
    const embed = createEmbedClient(fetchImpl);
    for (let i = 0; i < 51; i++) await embed(`q${i}`);
    await embed("q0"); // evicted, so fetched again
    await embed("q50"); // still cached
    expect(calls.filter((c) => c === "q0")).toHaveLength(2);
    expect(calls.filter((c) => c === "q50")).toHaveLength(1);
  });
});
