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
  const { provider, tools, system, maxIterations, retry, maxToolResultChars, maxRunMs } = options;
  const emit = (event: AgentEvent) => options.onEvent?.(event);

  return {
    async run(input, runOptions = {}): Promise<AgentResult> {
      const deadline = maxRunMs === undefined ? undefined : AbortSignal.timeout(maxRunMs);
      const signal = deadline && runOptions.signal ? AbortSignal.any([deadline, runOptions.signal]) : (deadline ?? runOptions.signal);
      /** Providers and tools may ignore the signal, so the run does not wait for them after an abort. */
      const orAbort = <T>(work: Promise<T>): Promise<T> =>
        signal ? Promise.race([work, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }))]) : work;
      const stopped = (iterations: number): AgentResult | null =>
        deadline?.aborted ? timedOut(iterations) : signal?.aborted ? fail(iterations, "Aborted") : null;
      const timedOut = (iterations: number): AgentResult => {
        emit({ type: "timed_out", ms: maxRunMs! });
        return { status: "timed_out", transcript, iterations };
      };
      const transcript: ChatMessage[] = [
        { role: "system", content: system },
        ...(runOptions.history ?? []).filter((m) => m.role !== "system"),
        { role: "user", content: input },
      ];
      const cache = new Map<string, unknown>();
      let validationErrors = 0;
      const fail = (iterations: number, error: string): AgentResult => ({ status: "failed", transcript, iterations, error });
      const TRUNCATED = "…[truncated]";
      const reply = (call: ToolCall, content: string) => {
        const fits = !maxToolResultChars || content.length <= maxToolResultChars;
        const sent = fits ? content : content.slice(0, maxToolResultChars - TRUNCATED.length) + TRUNCATED;
        transcript.push({ role: "tool", toolCallId: call.id, content: sent });
        return { chars: sent.length, truncated: !fits };
      };

      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        const before = stopped(iteration - 1);
        if (before) return before;
        emit({ type: "llm_request", iteration });

        let message: ChatMessage;
        const started = Date.now();
        try {
          const response = await orAbort(provider.complete({ messages: transcript, tools: tools.specs(), signal }));
          message = response.message;
          emit({ type: "llm_response", iteration, ms: Date.now() - started, usage: response.usage, model: response.model, toolCalls: message.toolCalls?.length ?? 0 });
        } catch (e) {
          const halted = stopped(iteration);
          if (halted) return halted;
          return fail(iteration, `LLM provider "${provider.name}" failed: ${errorText(e)}`);
        }
        transcript.push(message);

        const calls = message.toolCalls ?? [];
        if (!calls.length) {
          return { status: "done", message, transcript, iterations: iteration };
        }

        for (const call of calls) {
          const halted = stopped(iteration);
          if (halted) return halted;
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
            emit({ type: "tool_result", callId: call.id, result, cached: true, ...reply(call, stableStringify(result)) });
            continue;
          }
          try {
            const result = await orAbort(tool.run(args, { callId: call.id, signal }));
            if (key) cache.set(key, result);
            emit({ type: "tool_result", callId: call.id, result, cached: false, ...reply(call, stableStringify(result)) });
          } catch (e) {
            const halted = stopped(iteration);
            if (halted) return halted;
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
