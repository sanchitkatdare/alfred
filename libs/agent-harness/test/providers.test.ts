import { describe, expect, it } from "vitest";
import { createHttpProvider, fromOpenAIResponse, toOpenAIMessages, toOpenAITools, type ChatMessage } from "../src";

describe("OpenAI format adapter", () => {
  it("converts tool calls and tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "comedy please" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "search_movies", arguments: { genres: ["comedy"] } }] },
      { role: "tool", toolCallId: "c1", content: "[]" },
    ];
    expect(toOpenAIMessages(messages)).toEqual([
      { role: "user", content: "comedy please" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "search_movies", arguments: '{"genres":["comedy"]}' } }] },
      { role: "tool", content: "[]", tool_call_id: "c1" },
    ]);
  });

  it("replaces malformed arguments with {} when sending the transcript back", () => {
    const [m] = toOpenAIMessages([{ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", arguments: '{"a": 1 "b": 2}' }] }]);
    expect(m!.tool_calls![0]!.function.arguments).toBe("{}");
  });

  it("wraps tool specs", () => {
    expect(toOpenAITools([{ name: "a", description: "d", parameters: { type: "object" } }])).toEqual([
      { type: "function", function: { name: "a", description: "d", parameters: { type: "object" } } },
    ]);
  });

  it("parses a Workers AI response with tool calls and neurons", () => {
    const r = fromOpenAIResponse({
      choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "search_movies", arguments: '{"genres": ["comedy"]}' } }] } }],
      usage: { prompt_tokens: 234, completion_tokens: 28, neurons: 0.65 },
    });
    expect(r.message).toEqual({ role: "assistant", content: "", toolCalls: [{ id: "x", name: "search_movies", arguments: { genres: ["comedy"] } }] });
    expect(r.usage).toEqual({ inputTokens: 234, outputTokens: 28, neurons: 0.65 });
  });

  it("keeps unparseable arguments as a string for validation", () => {
    const r = fromOpenAIResponse({ choices: [{ message: { tool_calls: [{ id: "x", function: { name: "f", arguments: "{bad json" } }] } }] });
    expect(r.message.toolCalls![0]!.arguments).toBe("{bad json");
  });

  it("parses double-encoded arguments", () => {
    const double = JSON.stringify(JSON.stringify({ people: ["Christopher Nolan"] }));
    const r = fromOpenAIResponse({ choices: [{ message: { tool_calls: [{ id: "x", function: { name: "f", arguments: double } }] } }] });
    expect(r.message.toolCalls![0]!.arguments).toEqual({ people: ["Christopher Nolan"] });
  });

  it("strips reasoning blocks and falls back to the legacy response field", () => {
    expect(fromOpenAIResponse({ choices: [{ message: { content: "<think>hmm</think>\n\nTry Heat." } }] }).message.content).toBe("Try Heat.");
    expect(fromOpenAIResponse({ response: "Legacy answer" }).message.content).toBe("Legacy answer");
  });
});

describe("HTTP provider", () => {
  it("sends the conversation without the system message and returns the message", async () => {
    let sent: unknown;
    const provider = createHttpProvider("/api/movies/chat", {
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init!.body));
        return new Response(JSON.stringify({ message: { role: "assistant", content: "Hi" }, usage: { inputTokens: 1, outputTokens: 1 } }));
      },
    });
    const r = await provider.complete({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], tools: [] });
    expect(sent).toEqual({ messages: [{ role: "user", content: "u" }] });
    expect(r.message.content).toBe("Hi");
  });

  it("throws the server error message", async () => {
    const provider = createHttpProvider("/x", { fetch: async () => new Response(JSON.stringify({ error: "Daily AI quota used up" }), { status: 502 }) });
    await expect(provider.complete({ messages: [], tools: [] })).rejects.toThrow("Daily AI quota used up");
  });
});
