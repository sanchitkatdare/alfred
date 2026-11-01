import { createScriptedProvider, say, toolCalls } from "@alfred/agent-harness/testing";
import { describe, expect, it } from "vitest";
import { createMovieAssistant, isTimeout, MAX_TOOL_RESULT_CHARS, MODEL_TOO_SLOW, timeoutMessage } from "./assistant";
import { SAMPLE_CATALOG } from "./sample-catalog.fixture";

const context = {
  catalog: SAMPLE_CATALOG,
  getWatched: () => new Set<number>(),
  search: async () => [],
  details: async (ids: number[]) => ids.map((id) => ({ id, overview: "x".repeat(2_000), tagline: "", keywords: "" })),
};

describe("movie assistant", () => {
  it("applies parser hints to the model's search", async () => {
    const provider = createScriptedProvider([toolCalls(["search_movies", { genres: ["crime"], limit: 10 }]), say("done")]);
    await createMovieAssistant(context, provider)("crime without pacino", { hints: { excludePeople: ["Al Pacino"] } });
    const result = JSON.parse(provider.requests[1]!.messages.at(-1)!.content);
    expect(result.movies.some((m: { cast: string[] }) => m.cast.includes("Al Pacino"))).toBe(false);
  });

  it("keeps tool results under the server's limit", async () => {
    const provider = createScriptedProvider([toolCalls(["get_movie_details", { ids: [1, 2, 3] }]), say("done")]);
    await createMovieAssistant(context, provider)("tell me about these");
    expect(provider.requests[1]!.messages.at(-1)!.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it("uses the oracle provider only for the oracle tier", async () => {
    const standard = createScriptedProvider([say("default")]);
    const oracle = createScriptedProvider([say("oracle")]);
    const ask = createMovieAssistant(context, standard, oracle);
    expect((await ask("a", { tier: "oracle" })).message?.content).toBe("oracle");
    expect((await ask("b")).message?.content).toBe("default");
  });

  it("lists found movies when time runs out, without inventing any", () => {
    expect(timeoutMessage([{ title: "Heat", year: 1995 }])).toContain("- Heat (1995)");
    expect(timeoutMessage([])).toBe("Ran out of time. Try describing the movie differently.");
  });

  it("treats both time limits as a timeout, and other failures not", () => {
    expect(isTimeout({ status: "timed_out", transcript: [], iterations: 1 })).toBe(true);
    expect(isTimeout({ status: "failed", transcript: [], iterations: 1, error: `LLM provider "x" failed: ${MODEL_TOO_SLOW}` })).toBe(true);
    expect(isTimeout({ status: "failed", transcript: [], iterations: 1, error: "Daily AI quota used up" })).toBe(false);
  });

  it("sends earlier turns as history", async () => {
    const provider = createScriptedProvider([say("Shorter one: Memento.")]);
    await createMovieAssistant(context, provider)("something shorter", { history: [{ role: "user", content: "a thriller" }, { role: "assistant", content: "Heat." }] });
    expect(provider.requests[0]!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});
