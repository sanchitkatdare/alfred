import { z } from "zod";
import type { Agent, AgentEvent, AgentOptions, AgentResult, ChatMessage, ToolCall } from "./agent";

/** JSON with sorted keys, so { a, b } and { b, a } give the same idempotency key. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs the loop described in agent.ts. */
export function createAgent(options: AgentOptions): Agent {
  const { provider, tools, system, maxIterations, retry } = options;
  const emit = (event: AgentEvent) => options.onEvent?.(event);

  return {
    async run(input, runOptions = {}): Promise<AgentResult> {
      const signal = runOptions.signal;
      const transcript: ChatMessage[] = [
        { role: "system", content: system },
        { role: "user", content: input },
      ];
      const cache = new Map<string, unknown>();
      let validationErrors = 0;
      const fail = (iterations: number, error: string): AgentResult => ({ status: "failed", transcript, iterations, error });
      const reply = (call: ToolCall, content: string) => transcript.push({ role: "tool", toolCallId: call.id, content });

      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (signal?.aborted) return fail(iteration - 1, "Aborted");
        emit({ type: "llm_request", iteration });

        let message: ChatMessage;
        try {
          message = (await provider.complete({ messages: transcript, tools: tools.specs(), signal })).message;
        } catch (e) {
          return fail(iteration, `LLM provider "${provider.name}" failed: ${errorText(e)}`);
        }
        transcript.push(message);

        const calls = message.toolCalls ?? [];
        if (!calls.length) {
          emit({ type: "final", message });
          return { status: "done", message, transcript, iterations: iteration };
        }

        for (const call of calls) {
          emit({ type: "tool_call", call });
          const tool = tools.get(call.name);
          const parsed = tool?.schema.safeParse(call.arguments);
          if (!tool || !parsed?.success) {
            const error = !tool
              ? `Unknown tool "${call.name}". Available tools: ${tools.list().map((t) => t.name).join(", ")}.`
              : `Invalid arguments for "${call.name}": ${z.prettifyError(parsed!.error!)}`;
            validationErrors++;
            emit({ type: "validation_error", call, error, attempt: validationErrors });
            if (validationErrors > retry.maxValidationRetries) {
              return fail(iteration, `Too many invalid tool calls. Last error: ${error}`);
            }
            reply(call, `${error}\nFix the call and try again.`);
            continue;
          }

          const args = parsed.data;
          const key = tool.idempotent ? (tool.callKey?.(args) ?? `${tool.name}:${stableStringify(args)}`) : null;
          if (key && cache.has(key)) {
            const result = cache.get(key);
            emit({ type: "tool_result", callId: call.id, result, cached: true });
            reply(call, stableStringify(result));
            continue;
          }
          try {
            const result = await tool.run(args, { callId: call.id, signal });
            if (key) cache.set(key, result);
            emit({ type: "tool_result", callId: call.id, result, cached: false });
            reply(call, stableStringify(result));
          } catch (e) {
            const error = `Tool "${call.name}" failed: ${errorText(e)}`;
            emit({ type: "tool_error", call, error });
            reply(call, error);
          }
        }
      }

      emit({ type: "limit_reached", iterations: maxIterations });
      return { status: "limit_reached", transcript, iterations: maxIterations };
    },
  };
}
