import type { ChatMessage, LLMProvider, LLMRequest } from "./agent";

export type ScriptStep = ChatMessage | Error | ((request: LLMRequest) => ChatMessage);

/**
 * Mock LLM for tests. Returns the scripted steps in order and records every request.
 * An Error step makes complete() reject.
 */
export function createScriptedProvider(steps: ScriptStep[]): LLMProvider & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  let next = 0;
  return {
    name: "scripted",
    requests,
    async complete(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const step = steps[next++];
      if (!step) throw new Error(`Script has no step ${next}`);
      if (step instanceof Error) throw step;
      return { message: typeof step === "function" ? step(request) : step };
    },
  };
}

/** Shorthand for an assistant message that calls tools. */
export function toolCalls(...calls: [name: string, args: unknown][]): ChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: calls.map(([name, args], i) => ({ id: `call_${name}_${i}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args })),
  };
}

export const say = (content: string): ChatMessage => ({ role: "assistant", content });
