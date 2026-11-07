import type { AgentResult } from "@alfred/agent-harness";
import { describe, expect, it } from "vitest";
import { MODEL_TOO_SLOW } from "./assistant";
import { turnOutcome } from "./useAssistantConversation";

const run = (r: Partial<AgentResult>): AgentResult => ({ status: "done", transcript: [], iterations: 1, ...r });
const reply = (content: string) => run({ message: { role: "assistant", content } });
const found = [{ title: "Heat", year: 1995 }];
const seen = [{ id: 1, title: "Heat" }, { id: 2, title: "Ronin" }];

describe("turnOutcome", () => {
  it("shows the answer and the movies it names", () => {
    expect(turnOutcome(reply("Try Ronin (1998)."), "default", found, seen)).toEqual({ status: "done", answer: "Try Ronin (1998).", picks: [2] });
  });

  it.each([["", "default"], ["   ", "default"], ["", "oracle"]] as const)("treats an empty reply %j as a failure (%s)", (content, tier) => {
    const out = turnOutcome(reply(content), tier, [], seen);
    expect(out.status).toBe("failed");
    expect(out.error).toBe(tier === "oracle" ? "Oracle gave no answer. Try again." : "Alfred gave no answer. Try again, or ask Oracle.");
    expect(out.offerOracle).toBe(tier === "default");
  });

  it("treats a reply without a message as empty", () => {
    expect(turnOutcome(run({}), "default", [], seen).error).toContain("no answer");
  });

  it.each([
    ["the time limit", run({ status: "timed_out" })],
    ["a slow model on the server", run({ status: "failed", error: `LLM provider "x" failed: ${MODEL_TOO_SLOW}` })],
  ])("lists the movies found so far after %s", (_, result) => {
    const out = turnOutcome(result, "default", found, seen);
    expect(out).toMatchObject({ status: "failed", offerOracle: true });
    expect(out.error).toContain("Alfred took too long");
    expect(out.error).toContain("- Heat (1995)");
  });

  it("explains the step limit", () => {
    expect(turnOutcome(run({ status: "limit_reached" }), "default", [], seen)).toEqual({ status: "failed", error: "The assistant ran out of steps. Try a more specific question.", offerOracle: true });
  });

  it("says Stopped after the user stops, without offering Oracle", () => {
    expect(turnOutcome(run({ status: "failed", error: "Aborted" }), "default", [], seen)).toEqual({ status: "failed", error: "Stopped." });
  });

  it("shows a server error without the harness prefix, and does not offer Oracle to Oracle", () => {
    const out = turnOutcome(run({ status: "failed", error: 'LLM provider "workers-ai" failed: The assistant is unavailable right now. Search and filters still work.' }), "oracle", [], seen);
    expect(out).toEqual({ status: "failed", error: "The assistant is unavailable right now. Search and filters still work.", offerOracle: false });
  });

  it("never shows a raw network error", () => {
    const out = turnOutcome(run({ status: "failed", error: "TypeError: Failed to fetch" }), "default", [], seen);
    expect(out.error).not.toMatch(/TypeError|fetch/);
  });
});
