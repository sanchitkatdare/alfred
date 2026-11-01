import { describe, expect, it } from "vitest";
import { CHAT_TIER_MODELS, chatRequestSchema, MOVIE_CHAT_MODEL, runMovieChat } from "./chat";
import type { Env } from "./env";

function fakeEnv() {
  const inputs: Record<string, unknown>[] = [];
  const env = { AI: { run: async (_model: string, input: Record<string, unknown>) => (inputs.push(input), { choices: [{ message: { content: "ok" } }] }) } } as unknown as Env;
  return { env, inputs };
}

describe("chat tiers", () => {
  const messages = [{ role: "user", content: "x" }];

  it("uses the default model unless the oracle tier is named", () => {
    expect(CHAT_TIER_MODELS[chatRequestSchema.parse({ messages }).tier]).toBe(MOVIE_CHAT_MODEL);
    expect(CHAT_TIER_MODELS[chatRequestSchema.parse({ messages, tier: "oracle" }).tier]).not.toBe(MOVIE_CHAT_MODEL);
  });

  it("does not let the browser choose a model", () => {
    expect(chatRequestSchema.parse({ messages, model: "@cf/any/model" })).not.toHaveProperty("model");
    expect(chatRequestSchema.safeParse({ messages, tier: "@cf/any/model" }).success).toBe(false);
  });
});

describe("runMovieChat", () => {
  it("requires a tool call on the first model call for a new question", async () => {
    const { env, inputs } = fakeEnv();
    await runMovieChat(env, [{ role: "user", content: "movies with dicaprio and tom hardy" }], { gateway: false });
    expect(inputs[0]!.tool_choice).toBe("required");
  });

  it("lets the model answer once tool results are in", async () => {
    const { env, inputs } = fakeEnv();
    await runMovieChat(env, [
      { role: "user", content: "x" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "search_movies", arguments: {} }] },
      { role: "tool", toolCallId: "c1", content: "{}" },
    ], { gateway: false });
    expect(inputs[0]).not.toHaveProperty("tool_choice");
  });
});
