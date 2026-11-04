import { createAgent, createHttpProvider, createToolRegistry, trimHistory, type AgentEvent, type AgentResult, type ChatMessage, type LLMProvider } from "@alfred/agent-harness";
import type { SearchHints } from "./hints";
import { createMovieTools, type MovieToolContext } from "./tools";

/** Earlier turns kept per request. The server allows 24,000 characters per conversation; one new turn can add about 12,000. */
export const HISTORY_CHARS = 8_000;
/** Just under the server's 4,000-character limit for tool messages. */
export const MAX_TOOL_RESULT_CHARS = 3_900;

/** Time limit for one question. Measured 2026-11-01: granite 9.2 s p90, gemma 41 s on the slowest of 5 tasks. */
export const QUESTION_LIMIT_MS = { default: 30_000, oracle: 60_000 } as const;
/** Server error when one model call passes its time limit. */
export const MODEL_TOO_SLOW = "The model took too long.";

/** True when the run ended because of a time limit, either for the question or for one model call. */
export function isTimeout(result: AgentResult): boolean {
  return result.status === "timed_out" || !!result.error?.endsWith(MODEL_TOO_SLOW);
}

/** Answer without the LLM when time runs out: the movies its last search found, if any. */
export function timeoutMessage(movies: { title: string; year: number }[]): string {
  if (!movies.length) return "Ran out of time. Try describing the movie differently.";
  return `Ran out of time. Closest matches found so far:\n${movies.map((m) => `- ${m.title} (${m.year})`).join("\n")}`;
}

export interface AskOptions {
  /** Earlier turns from previous results (`result.transcript`). Trimmed here. */
  history?: ChatMessage[];
  /** Filters the rule parser took from this question. */
  hints?: SearchHints;
  /** Which provider answers. Default: "default". */
  tier?: "default" | "oracle";
  signal?: AbortSignal;
  onEvent?(event: AgentEvent): void;
}

/** Runs the movie assistant in the browser. The server picks the model and adds the system prompt. */
export function createMovieAssistant(context: Omit<MovieToolContext, "getHints">, provider: LLMProvider = createHttpProvider("/api/movies/chat"), oracle: LLMProvider = createHttpProvider("/api/movies/chat", { body: { tier: "oracle" } })) {
  return (question: string, options: AskOptions = {}): Promise<AgentResult> => {
    const tools = createToolRegistry(createMovieTools({ ...context, getHints: () => options.hints ?? {} }));
    const agent = createAgent({
      provider: options.tier === "oracle" ? oracle : provider,
      maxRunMs: QUESTION_LIMIT_MS[options.tier ?? "default"],
      tools,
      system: "Set by the server.",
      maxIterations: 5,
      retry: { maxValidationRetries: 2 },
      maxToolResultChars: MAX_TOOL_RESULT_CHARS,
      onEvent: options.onEvent,
    });
    return agent.run(question, { signal: options.signal, history: trimHistory(options.history ?? [], HISTORY_CHARS) });
  };
}
