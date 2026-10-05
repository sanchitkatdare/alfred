import { createAgent, createHttpProvider, createToolRegistry, trimHistory, type AgentEvent, type AgentResult, type ChatMessage, type LLMProvider } from "@alfred/agent-harness";
import type { SearchHints } from "./hints";
import { createMovieTools, type MovieToolContext } from "./tools";

/** Earlier turns kept per request. The server allows 24,000 characters per conversation; one new turn can add about 12,000. */
export const HISTORY_CHARS = 8_000;
/** Just under the server's 4,000-character limit for tool messages. */
export const MAX_TOOL_RESULT_CHARS = 3_900;

export interface AskOptions {
  /** Earlier turns from previous results (`result.transcript`). Trimmed here. */
  history?: ChatMessage[];
  /** Filters the rule parser took from this question. */
  hints?: SearchHints;
  signal?: AbortSignal;
  onEvent?(event: AgentEvent): void;
}

/** Runs the movie assistant in the browser. The server picks the model and adds the system prompt. */
export function createMovieAssistant(context: Omit<MovieToolContext, "getHints">, provider: LLMProvider = createHttpProvider("/api/movies/chat")) {
  return (question: string, options: AskOptions = {}): Promise<AgentResult> => {
    const tools = createToolRegistry(createMovieTools({ ...context, getHints: () => options.hints ?? {} }));
    const agent = createAgent({
      provider,
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
