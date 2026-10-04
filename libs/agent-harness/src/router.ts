import type { ParseResult } from "./parser";

/**
 * Level 1 routes:
 * - local: rules understood every word. Filter in the browser. 0 AI calls.
 * - semantic: free text remains. 1 embedding + vector search. 0 LLM calls.
 * - assistant: a task was requested. Escalate to a workflow or the agent loop.
 * - empty: nothing to act on yet.
 */
export type Route = "local" | "semantic" | "assistant" | "empty";

export interface RouteDecision {
  route: Route;
  reason: string;
}

export interface RouterOptions {
  /** Chip kind that marks a task. Default "task". */
  taskKind?: string;
  /** Chip kinds that need vector search even without free text, for example "similar". */
  semanticKinds?: string[];
}

export function decideRoute(result: Pick<ParseResult, "chips" | "leftover">, options: RouterOptions = {}): RouteDecision {
  const taskKind = options.taskKind ?? "task";
  const semanticKinds = new Set(options.semanticKinds ?? []);
  const tasks = result.chips.filter((c) => c.kind === taskKind);
  if (tasks.length) {
    return { route: "assistant", reason: `Task requested: ${tasks.map((t) => t.label).join(", ")}` };
  }
  const semanticChip = result.chips.find((c) => semanticKinds.has(c.kind));
  if (result.leftover.length || semanticChip) {
    const why = result.leftover.length ? `Free text remains: "${result.leftover.join(" ")}"` : `"${semanticChip!.kind}" needs vector search`;
    return { route: "semantic", reason: why };
  }
  if (result.chips.length) return { route: "local", reason: "Rules matched every word" };
  return { route: "empty", reason: "Nothing to act on yet" };
}
