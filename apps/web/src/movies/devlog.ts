import type { AgentEvent } from "@alfred/agent-harness";
import { useCallback, useState } from "react";

export const short = (value: unknown, max = 110) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Pipeline stage of a dev-mode item. */
export type Stage = "data" | "rules" | "search" | "assistant";

export interface DevItem {
  stage: Stage;
  label: string;
  detail?: string;
  ms?: number;
  neurons?: number;
  /** True when the item made a request to our API. */
  serverCall?: boolean;
}

export interface DevEntry {
  id: number;
  kind: "load" | "search" | "assistant" | "lookup";
  title: string;
  started: number;
  ms?: number;
  items: DevItem[];
}

const MAX_ENTRIES = 10;
let nextId = 1;

/** Request log for dev mode: one entry per page load, search or assistant run, newest first. */
export function useDevLog() {
  const [entries, setEntries] = useState<DevEntry[]>([]);
  const start = useCallback((kind: DevEntry["kind"], title: string) => {
    const id = nextId++;
    setEntries((all) => [{ id, kind, title, started: performance.now(), items: [] }, ...all].slice(0, MAX_ENTRIES));
    return id;
  }, []);
  const add = useCallback((id: number | null, item: DevItem) => {
    if (id === null) return;
    setEntries((all) => all.map((e) => (e.id === id ? { ...e, items: [...e.items, item] } : e)));
  }, []);
  const finish = useCallback((id: number) => {
    setEntries((all) => all.map((e) => (e.id === id ? { ...e, ms: Math.round(performance.now() - e.started) } : e)));
  }, []);
  return { entries, start, add, finish };
}

export type DevLog = ReturnType<typeof useDevLog>;

export const totals = (entry: DevEntry) => ({
  neurons: entry.items.reduce((n, i) => n + (i.neurons ?? 0), 0),
  serverCalls: entry.items.filter((i) => i.serverCall).length,
});

/** Dev-mode line for each harness event; null for events the dev log does not show. */
export function devItemFor(e: AgentEvent) {
  switch (e.type) {
    case "llm_response":
      return {
        stage: "assistant" as const,
        label: `Model call ${e.iteration}`,
        detail: `${e.model ? `${e.model.split("/").pop()} · ` : ""}${e.toolCalls} tool call${e.toolCalls === 1 ? "" : "s"}${e.usage ? ` · ${e.usage.inputTokens} in / ${e.usage.outputTokens} out tokens` : ""}`,
        ms: e.ms,
        neurons: e.usage?.neurons,
        serverCall: true,
      };
    case "tool_call":
      return { stage: "assistant" as const, label: `Tool: ${e.call.name}`, detail: `model asked for ${short(e.call.arguments, 160)}` };
    case "tool_result":
      return { stage: "assistant" as const, label: "Tool result", detail: `${e.chars} characters sent to the model${e.truncated ? ", truncated" : ""}${e.cached ? ", repeat call (not run)" : ""}` };
    case "validation_error":
      return { stage: "assistant" as const, label: "Invalid tool call, sent back", detail: short(e.error.split("\n")[0], 160) };
    case "tool_error":
      return { stage: "assistant" as const, label: "Tool error", detail: e.error };
    case "limit_reached":
      return { stage: "assistant" as const, label: "Step limit reached", detail: `${e.iterations} model calls` };
    case "timed_out":
      return { stage: "assistant" as const, label: "Time limit reached", detail: `${e.ms / 1000} s` };
    default:
      return null;
  }
}
