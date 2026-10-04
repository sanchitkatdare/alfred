/**
 * Agent harness contracts (Levels 2 and 3). The loop is implemented in loop.ts.
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
  register<A, R>(tool: Tool<A, R>): void;
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
  | { type: "tool_call"; call: ToolCall }
  | { type: "validation_error"; call: ToolCall; error: string; attempt: number }
  | { type: "tool_result"; callId: string; result: unknown; cached: boolean }
  | { type: "tool_error"; call: ToolCall; error: string }
  | { type: "final"; message: ChatMessage }
  | { type: "limit_reached"; iterations: number };

export interface AgentOptions {
  provider: LLMProvider;
  tools: ToolRegistry;
  system: string;
  maxIterations: number;
  retry: RetryPolicy;
  /** For the decision trace in the UI. */
  onEvent?(event: AgentEvent): void;
}

export interface AgentResult {
  status: "done" | "limit_reached" | "failed";
  message?: ChatMessage;
  transcript: ChatMessage[];
  iterations: number;
  error?: string;
}

export interface Agent {
  run(input: string, options?: { signal?: AbortSignal }): Promise<AgentResult>;
}

/** Level 2: fixed steps in code. The LLM, if used at all, does one narrow subtask. */
export interface Workflow<Input, Output> {
  name: string;
  run(input: Input, context: { provider?: LLMProvider; signal?: AbortSignal }): Promise<Output>;
}
