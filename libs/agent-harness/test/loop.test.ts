import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgent, createToolRegistry, defineTool, type AgentEvent, type AgentOptions } from "../src";
import { createScriptedProvider, say, toolCalls, type ScriptStep } from "../src/testing";

function setup(steps: ScriptStep[], overrides: Partial<AgentOptions> = {}) {
  const writes: string[] = [];
  const search = defineTool({
    name: "search_catalog",
    description: "Search movies by genre.",
    schema: z.object({ genre: z.string(), limit: z.number().int().min(1).max(10) }),
    run: async ({ genre, limit }) => ({ ids: Array.from({ length: limit }, (_, i) => `${genre}-${i}`) }),
  });
  const addToList = defineTool({
    name: "add_to_watchlist",
    description: "Add a movie to the watchlist.",
    schema: z.object({ movieId: z.number() }),
    idempotent: true,
    run: async ({ movieId }) => {
      writes.push(String(movieId));
      return { added: movieId };
    },
  });
  const broken = defineTool({
    name: "broken",
    description: "Always throws.",
    schema: z.object({}),
    run: async () => {
      throw new Error("database offline");
    },
  });
  const provider = createScriptedProvider(steps);
  const events: AgentEvent[] = [];
  const agent = createAgent({
    provider,
    tools: createToolRegistry([search, addToList, broken]),
    system: "You recommend movies.",
    maxIterations: 5,
    retry: { maxValidationRetries: 2 },
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { agent, provider, events, writes };
}

const lastToolMessage = (provider: ReturnType<typeof createScriptedProvider>) =>
  provider.requests.at(-1)!.messages.filter((m) => m.role === "tool").at(-1)!.content;

describe("agent loop", () => {
  it("finishes when the LLM replies without a tool call", async () => {
    const { agent } = setup([say("Try Heat.")]);
    const result = await agent.run("a crime movie");
    expect(result).toMatchObject({ status: "done", iterations: 1, message: { content: "Try Heat." } });
  });

  it("runs a tool and sends the result back to the LLM", async () => {
    const { agent, provider } = setup([toolCalls(["search_catalog", { genre: "crime", limit: 2 }]), say("Found two.")]);
    const result = await agent.run("a crime movie");
    expect(result.status).toBe("done");
    expect(lastToolMessage(provider)).toBe('{"ids":["crime-0","crime-1"]}');
  });

  it("sends tool specs as JSON Schema", async () => {
    const { agent, provider } = setup([say("ok")]);
    await agent.run("hi");
    const spec = provider.requests[0]!.tools.find((t) => t.name === "search_catalog")!;
    expect(spec.parameters).toMatchObject({ type: "object", required: ["genre", "limit"] });
  });

  it("feeds a validation error back so the LLM can correct itself", async () => {
    const { agent, provider, events } = setup([
      toolCalls(["search_catalog", { genre: "crime", limit: "five" }]),
      toolCalls(["search_catalog", { genre: "crime", limit: 5 }]),
      say("Corrected."),
    ]);
    const result = await agent.run("five crime movies");
    expect(result.status).toBe("done");
    expect(provider.requests[1]!.messages.at(-1)!.content).toMatch(/Invalid arguments for "search_catalog"[\s\S]*limit/);
    expect(events.filter((e) => e.type === "validation_error")).toHaveLength(1);
  });

  it("fails after too many invalid calls", async () => {
    const bad = toolCalls(["search_catalog", { genre: 1 }]);
    const { agent } = setup([bad, bad, bad]);
    const result = await agent.run("x");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Too many invalid tool calls/);
  });

  it("reports an unknown tool and lists the available ones", async () => {
    const { agent, provider } = setup([toolCalls(["delete_everything", {}]), say("Sorry.")]);
    await agent.run("x");
    expect(lastToolMessage(provider)).toMatch(/Unknown tool "delete_everything"\. Available tools: search_catalog, add_to_watchlist, broken/);
  });

  it("does not repeat an idempotent write during retries", async () => {
    const { agent, writes, events } = setup([
      toolCalls(["add_to_watchlist", { movieId: 4 }]),
      toolCalls(["add_to_watchlist", { movieId: 4 }]),
      say("Added."),
    ]);
    await agent.run("add Heat");
    expect(writes).toEqual(["4"]);
    expect(events.filter((e) => e.type === "tool_result").map((e) => e.type === "tool_result" && e.cached)).toEqual([false, true]);
  });

  it("sends a tool exception back to the LLM and continues", async () => {
    const { agent, provider } = setup([toolCalls(["broken", {}]), say("The database is offline.")]);
    const result = await agent.run("x");
    expect(result.status).toBe("done");
    expect(lastToolMessage(provider)).toBe('Tool "broken" failed: database offline');
  });

  it("stops at the iteration limit", async () => {
    const loop = toolCalls(["search_catalog", { genre: "crime", limit: 1 }]);
    const { agent, events } = setup([loop, loop, loop], { maxIterations: 3 });
    const result = await agent.run("x");
    expect(result).toMatchObject({ status: "limit_reached", iterations: 3 });
    expect(events.at(-1)).toEqual({ type: "limit_reached", iterations: 3 });
  });

  it("fails when the provider fails", async () => {
    const { agent } = setup([new Error("quota exceeded")]);
    const result = await agent.run("x");
    expect(result).toMatchObject({ status: "failed", error: 'LLM provider "scripted" failed: quota exceeded' });
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const { agent } = setup([
      () => {
        controller.abort();
        return toolCalls(["search_catalog", { genre: "crime", limit: 1 }]);
      },
      say("never sent"),
    ]);
    const result = await agent.run("x", { signal: controller.signal });
    expect(result).toMatchObject({ status: "failed", error: "Aborted", iterations: 1 });
  });
});

describe("tool registry", () => {
  it("rejects duplicate names", () => {
    const t = defineTool({ name: "a", description: "", schema: z.object({}), run: async () => null });
    expect(() => createToolRegistry([t, t])).toThrow(/already registered/);
  });
});
