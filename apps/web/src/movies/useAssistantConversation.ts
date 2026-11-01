import type { AgentResult, ChatMessage } from "@alfred/agent-harness";
import { useRef, useState, type RefObject } from "react";
import { friendlyError } from "./api";
import { describeEvent, type Turn } from "./AssistantPanel";
import { isTimeout, QUESTION_LIMIT_MS, timeoutMessage, type AskOptions } from "./assistant";
import { devItemFor, type DevLog } from "./devlog";
import type { SearchHints } from "./hints";

/** The agent conversation: visible turns, the history sent with follow-ups, and Stop. */
export function useAssistantConversation(ask: (question: string, options: AskOptions) => Promise<AgentResult>, dev: DevLog, currentEntry: RefObject<number | null>) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const running = turns.at(-1)?.status === "running";
  const history = useRef<ChatMessage[]>([]);
  const abort = useRef<AbortController | null>(null);

  const runAssistant = async (query: string, hints: SearchHints, logRules: (entry: number) => void, tier: "default" | "oracle" = "default") => {
    const question = query.trim();
    if (!question) return;
    const turnIndex = turns.length;
    const update = (change: (t: Turn) => Turn) => setTurns((all) => all.map((t, i) => (i === turnIndex ? change(t) : t)));
    const waitNote = tier === "oracle" ? [{ kind: "think" as const, text: `Oracle can take up to ${QUESTION_LIMIT_MS.oracle / 1000} s. Stop ends it early.` }] : [];
    setTurns((all) => [...all, { question, steps: waitNote, status: "running" }]);
    let found: { title: string; year: number }[] = [];
    abort.current = new AbortController();
    const entry = dev.start("assistant", question);
    currentEntry.current = entry;
    logRules(entry);
    try {
      const result = await ask(question, {
        history: history.current,
        hints,
        tier,
        signal: abort.current.signal,
        onEvent: (e) => {
          const movies = e.type === "tool_result" ? (e.result as { movies?: { title: string; year: number }[] }).movies : undefined;
          if (movies?.length) found = movies;
          const step = describeEvent(e);
          if (step) update((t) => ({ ...t, steps: [...t.steps, step] }));
          const item = devItemFor(e);
          if (item) dev.add(entry, item);
        },
      });
      if (result.status === "done") {
        history.current = result.transcript.filter((m) => m.role !== "system");
        update((t) => ({ ...t, status: "done", answer: result.message?.content || "(no answer)" }));
      } else if (isTimeout(result)) {
        update((t) => ({ ...t, status: "failed", error: timeoutMessage(found) }));
      } else {
        const error = result.status === "limit_reached" ? "The assistant ran out of steps. Try a more specific question." : friendlyError(result.error ?? "The assistant failed.");
        update((t) => ({ ...t, status: "failed", error: error === "Aborted" ? "Stopped." : error }));
      }
    } catch (e) {
      update((t) => ({ ...t, status: "failed", error: friendlyError(e) }));
    } finally {
      dev.finish(entry);
      currentEntry.current = null;
    }
  };

  const stop = () => abort.current?.abort();
  const resetConversation = () => {
    history.current = [];
    setTurns([]);
  };

  return { turns, running, runAssistant, stop, resetConversation };
}
