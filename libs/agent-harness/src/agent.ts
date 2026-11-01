/**
 * Agent harness contracts (Level 3, the agent loop). The loop is implemented in loop.ts.
 *
 * Loop contract for Agent.run:
 * 1. Send the transcript and tool specs to the LLMProvider.
 * 2. No tool call in the reply: finish with status "done".
 * 3. For each tool call: reject unknown tools, then validate arguments with the tool's Zod schema.
 *    On a validation error, append the error as a tool message and ask the LLM again.
 *    This self-correction counts against RetryPolicy.maxValidationRetries.
 * 4. Run valid calls. Idempotent tools return the cached result for a repeated call key,
 *    so a retry does not write twice. The cache lasts for one run.
 *    A tool that throws does not stop the run: the error goes back to the LLM as a tool message.
 * 5. Stop with status "limit_reached" after maxIterations LLM calls.
 * 6. A provider error or an abort stops the run with status "failed".
 */
import type { z } from "zod";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw arguments from the LLM. Not trusted until validated. */
  arguments: unknown;
}

export interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  /** Set on role "tool": the call this message answers. */
  toolCallId?: string;
}

/** Tool description sent to the LLM. `parameters` is JSON Schema, generated from the Zod schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface LLMResponse {
  message: ChatMessage;
  /** `neurons` is set by Workers AI. */
  usage?: { inputTokens: number; outputTokens: number; neurons?: number };
  /** Model that answered, when the provider reports it. */
  model?: string;
}

/** One adapter per backend: Workers AI, a mock for tests, later others. */
export interface LLMProvider {
  readonly name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export interface ToolContext {
  callId: string;
  signal?: AbortSignal;
}

export interface Tool<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<Args>;
  /** Safe to cache by call key during retries. Set true for tools that write. */
  idempotent?: boolean;
  /** Key for idempotency. Default: tool name + JSON of the validated arguments. */
  callKey?(args: Args): string;
  run(args: Args, context: ToolContext): Promise<Result>;
}

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  list(): Tool[];
  specs(): ToolSpec[];
}

export interface RetryPolicy {
  /** Validation errors sent back to the LLM before the run fails. */
  maxValidationRetries: number;
}

export type AgentEvent =
  | { type: "llm_request"; iteration: number }
  /** After each model call: duration and usage as reported by the provider. */
  | { type: "llm_response"; iteration: number; ms: number; usage?: LLMResponse["usage"]; model?: string; toolCalls: number }
  | { type: "tool_call"; call: ToolCall }
  | { type: "validation_error"; call: ToolCall; error: string; attempt: number }
  /** `chars` is the size sent back to the model; `truncated` when maxToolResultChars cut it. */
  | { type: "tool_result"; callId: string; result: unknown; cached: boolean; chars: number; truncated: boolean }
  | { type: "tool_error"; call: ToolCall; error: string }
  | { type: "limit_reached"; iterations: number }
  | { type: "timed_out"; ms: number };

export interface AgentOptions {
  provider: LLMProvider;
  tools: ToolRegistry;
  system: string;
  maxIterations: number;
  retry: RetryPolicy;
  /** Longest tool result sent back to the LLM. Longer results are cut and marked. Match the server's tool-message limit. */
  maxToolResultChars?: number;
  /** Time limit for one run. When it passes, the pending call is cancelled and the run ends as "timed_out". */
  maxRunMs?: number;
  /** For the decision trace in the UI. */
  onEvent?(event: AgentEvent): void;
}

export interface AgentResult {
  status: "done" | "limit_reached" | "timed_out" | "failed";
  message?: ChatMessage;
  transcript: ChatMessage[];
  iterations: number;
  error?: string;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  /** Earlier turns of the conversation (no system message). Placed before the new input. */
  history?: ChatMessage[];
}

export interface Agent {
  run(input: string, options?: AgentRunOptions): Promise<AgentResult>;
}
