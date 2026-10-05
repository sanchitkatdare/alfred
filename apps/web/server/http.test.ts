import { describe, expect, it } from "vitest";
import { chatRequestSchema } from "./chat";
import { guardApiRequest, LIMITS, readJsonBody } from "./http";

const req = (init: { method?: string; origin?: string | null; url?: string; body?: string; length?: number }) => {
  const headers = new Headers();
  if (init.origin !== null) headers.set("Origin", init.origin ?? "https://alfred.pages.dev");
  if (init.length !== undefined) headers.set("Content-Length", String(init.length));
  return new Request(init.url ?? "https://alfred.pages.dev/api/movies/chat", { method: init.method ?? "POST", headers, body: init.body });
};

describe("guardApiRequest", () => {
  it("allows same-site POST and local development", () => {
    expect(guardApiRequest(req({}))).toBeNull();
    expect(guardApiRequest(req({ origin: "http://localhost:5173", url: "http://127.0.0.1:8788/api/movies/chat" }))).toBeNull();
  });

  it.each([
    ["GET", { method: "GET" }, 405],
    ["missing Origin", { origin: null }, 403],
    ["another site", { origin: "https://evil.example" }, 403],
    ["malformed Origin", { origin: "not a url" }, 403],
    ["Content-Length over the limit", { length: LIMITS.bodyBytes + 1 }, 413],
  ] as const)("rejects %s", (_name, init, status) => {
    expect(guardApiRequest(req(init))?.status).toBe(status);
  });
});

describe("readJsonBody", () => {
  it("rejects a body over the limit without Content-Length", async () => {
    const r = await readJsonBody(req({ body: "x".repeat(LIMITS.bodyBytes + 1) }));
    expect(r.ok ? 200 : r.response.status).toBe(413);
  });

  it("rejects invalid JSON", async () => {
    const r = await readJsonBody(req({ body: "{oops" }));
    expect(r.ok ? 200 : r.response.status).toBe(400);
  });
});

describe("chat request limits", () => {
  const user = (n: number) => ({ role: "user" as const, content: "x".repeat(n) });
  it("accepts a normal conversation", () => {
    expect(chatRequestSchema.safeParse({ messages: [user(300)] }).success).toBe(true);
  });

  it("rejects a user message over 300 characters", () => {
    const r = chatRequestSchema.safeParse({ messages: [user(301)] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/user message is longer than 300/);
  });

  it("allows longer tool messages up to their own limit", () => {
    expect(chatRequestSchema.safeParse({ messages: [user(10), { role: "tool", toolCallId: "c", content: "x".repeat(4000) }] }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ messages: [user(10), { role: "tool", toolCallId: "c", content: "x".repeat(4001) }] }).success).toBe(false);
  });

  it("rejects a conversation over 24,000 characters in total", () => {
    const tools = Array.from({ length: 7 }, () => ({ role: "tool" as const, toolCallId: "c", content: "x".repeat(4000) }));
    const r = chatRequestSchema.safeParse({ messages: [user(10), ...tools] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/Start a new one/);
  });
});
