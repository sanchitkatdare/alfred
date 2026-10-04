import type { ChatMessage, ToolCall, ToolSpec } from "../agent";

/**
 * Conversion between harness types and the OpenAI chat format.
 * Used for Workers AI (env.AI.run accepts this format) and any OpenAI-compatible API.
 */

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * Arguments as a JSON string. Malformed model output is replaced with "{}": providers reject a
 * transcript containing invalid JSON, and the tool message already carries the validation error.
 */
function argumentsJson(args: unknown): string {
  if (typeof args !== "string") return JSON.stringify(args ?? {});
  try {
    JSON.parse(args);
    return args;
  } catch {
    return "{}";
  }
}

export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: argumentsJson(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAITools(tools: ToolSpec[]): OpenAITool[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Removes reasoning blocks some models put in the visible text. */
function cleanContent(text: unknown): string {
  return typeof text === "string" ? text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() : "";
}

/**
 * Reads the first choice of an OpenAI-style response. Falls back to top-level `tool_calls` and `response`,
 * which older Workers AI models return. Unparseable arguments stay as a string, so the agent loop reports
 * a validation error and the model can correct itself.
 */
export function fromOpenAIResponse(raw: unknown): { message: ChatMessage; usage?: { inputTokens: number; outputTokens: number; neurons?: number } } {
  const r = (raw ?? {}) as Record<string, any>;
  const msg = r.choices?.[0]?.message ?? {};
  const rawCalls: any[] = msg.tool_calls ?? r.tool_calls ?? [];
  const toolCalls: ToolCall[] = rawCalls.map((c, i) => {
    const fn = c.function ?? c;
    // Some models double-encode arguments (a JSON string inside a JSON string), so parse up to twice.
    let args: unknown = fn.arguments;
    for (let i = 0; i < 2 && typeof args === "string"; i++) {
      try {
        args = JSON.parse(args);
      } catch {
        break; // Keep the raw string. Schema validation reports it to the model.
      }
    }
    return { id: c.id ?? `call_${i}_${Date.now().toString(36)}`, name: fn.name, arguments: args };
  });
  const message: ChatMessage = { role: "assistant", content: cleanContent(msg.content ?? r.response), ...(toolCalls.length ? { toolCalls } : {}) };
  const u = r.usage;
  const usage = u ? { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, ...(typeof u.neurons === "number" ? { neurons: u.neurons } : {}) } : undefined;
  return usage ? { message, usage } : { message };
}
