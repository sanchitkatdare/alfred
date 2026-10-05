import { describe, expect, it } from "vitest";
import { embedQuery, embedRequestSchema } from "./embed";
import type { Env } from "./env";

const fakeEnv = (dims: number) => ({ AI: { run: async () => ({ data: [Array.from({ length: dims }, (_, i) => i / 1e6 + 0.1234567)] }) } }) as unknown as Env;

describe("embed", () => {
  it("validates the query text", () => {
    expect(embedRequestSchema.safeParse({ text: "  " }).success).toBe(false);
    expect(embedRequestSchema.safeParse({ text: "x".repeat(201) }).success).toBe(false);
    expect(embedRequestSchema.safeParse({ text: "dream heist" }).success).toBe(true);
  });

  it("returns a rounded 384-dimension vector", async () => {
    const { body } = await embedQuery(fakeEnv(384), "dream heist");
    expect(body.vector).toHaveLength(384);
    expect(body.vector[0]).toBe(0.12346);
  });

  it("rejects a vector with the wrong dimension count", async () => {
    await expect(embedQuery(fakeEnv(768), "x")).rejects.toThrow(/Expected 384/);
  });
});
