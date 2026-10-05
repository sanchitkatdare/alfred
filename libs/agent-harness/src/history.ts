import type { ChatMessage } from "./agent";

const size = (m: ChatMessage) => m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0);

/**
 * Keeps the most recent whole turns that fit in `maxChars`. A turn starts at a user message and
 * includes the assistant and tool messages after it, so no tool result is left without its call.
 * System messages are dropped: the server adds its own.
 */
export function trimHistory(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const turns: ChatMessage[][] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user" || !turns.length) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  const kept: ChatMessage[][] = [];
  let total = 0;
  for (const turn of turns.reverse()) {
    const turnSize = turn.reduce((n, m) => n + size(m), 0);
    if (total + turnSize > maxChars) break;
    kept.unshift(turn);
    total += turnSize;
  }
  return kept.flat().filter((_, i, all) => i > 0 || all[0]!.role === "user");
}
