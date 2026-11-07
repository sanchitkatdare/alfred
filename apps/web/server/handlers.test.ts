import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestPost as chat } from "../functions/api/movies/chat";
import { onRequestPost as embed } from "../functions/api/movies/embed";
import { onRequest as guard } from "../functions/api/_middleware";
import { MODEL_TOO_SLOW } from "../src/movies/assistant";
import type { Env } from "./env";
import { TimeoutError } from "./timing";

// The Pages Functions as the browser reaches them: same-site POST, JSON body, Workers AI behind env.AI.
const post = (path: string, body: unknown) =>
  new Request(`http://localhost:8788${path}`, { method: "POST", headers: { Origin: "http://localhost:8788", "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const envWith = (run: (...args: unknown[]) => Promise<unknown>) => ({ AI: { run } }) as unknown as Env;
const call = (fn: PagesFunction<Env>, request: Request, env: Env) => fn({ request, env } as unknown as Parameters<PagesFunction<Env>>[0]) as Promise<Response>;
const chatBody = { messages: [{ role: "user", content: "a heist movie" }] };

afterEach(() => vi.restoreAllMocks());

describe("chat endpoint errors", () => {
  it("answers 504 with the slow-model message when the model times out", async () => {
    const res = await call(chat, post("/api/movies/chat", chatBody), envWith(async () => { throw new TimeoutError("chat timed out"); }));
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: MODEL_TOO_SLOW });
  });

  it("answers 502 with a readable message and keeps the internal error in the log only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(chat, post("/api/movies/chat", chatBody), envWith(async () => { throw new Error("AiError: 4006: daily free allocation of 10,000 neurons used up (account 1234abcd)"); }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "The assistant is unavailable right now. Search and filters still work." });
    expect(text).not.toMatch(/4006|neurons|account/);
    expect(log).toHaveBeenCalled();
  });

  it("rejects a malformed request with 400 before calling the model", async () => {
    const run = vi.fn();
    const res = await call(chat, post("/api/movies/chat", { messages: [] }), envWith(run));
    expect(res.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with 400", async () => {
    const run = vi.fn();
    expect((await call(chat, post("/api/movies/chat", "{not json"), envWith(run))).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops a foreign origin in the /api middleware, before any handler", async () => {
    const next = vi.fn(async () => new Response("handler"));
    const foreign = new Request("http://localhost:8788/api/movies/chat", { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify(chatBody) });
    const res = (await guard({ request: foreign, next } as unknown as Parameters<PagesFunction>[0])) as Response;
    expect(res.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(await ((await guard({ request: post("/api/movies/chat", chatBody), next } as unknown as Parameters<PagesFunction>[0])) as Response).text()).toBe("handler");
  });
});

describe("embed endpoint errors", () => {
  it("answers 502 with a readable message when Workers AI fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(embed, post("/api/movies/embed", { text: "heist" }), envWith(async () => { throw new Error("AiError: 3040: capacity"); }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Search is unavailable right now. Filters still work." });
  });

  it("answers 502 for a vector of the wrong size", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(embed, post("/api/movies/embed", { text: "heist" }), envWith(async () => ({ data: [[0.1, 0.2]] })));
    expect(res.status).toBe(502);
  });

  it("rejects empty text with 400", async () => {
    const run = vi.fn();
    expect((await call(embed, post("/api/movies/embed", { text: "   " }), envWith(run))).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
});
