import type { AgentResult, ChatMessage } from "@alfred/agent-harness";
import { useRef, useState, type RefObject } from "react";
import { friendlyError } from "./api";
import { answerPicks, describeEvent, timelineItem, type Turn } from "./AssistantPanel";
import { isTimeout, QUESTION_LIMIT_MS, timeoutMessage, type AskOptions } from "./assistant";
import { devItemFor, type DevLog } from "./devlog";
import type { SearchHints } from "./hints";

type Outcome = Pick<Turn, "status" | "answer" | "picks" | "error" | "offerOracle">;

/**
 * What the user sees when a run ends. Every failure says what happened and, where it can help, offers Oracle.
 * `found` is the last search's movies (listed on a timeout); `seen` is every movie the tools returned (for picks).
 */
export function turnOutcome(result: AgentResult, tier: "default" | "oracle", found: { title: string; year: number }[], seen: { id: number; title: string }[]): Outcome {
  const offerOracle = tier === "default";
  if (result.status === "done") {
    const answer = result.message?.content?.trim();
    // An empty reply is a failure for the user, with the same way out as a timeout.
    if (!answer) return { status: "failed", error: offerOracle ? "Alfred gave no answer. Try again, or ask Oracle." : "Oracle gave no answer. Try again.", offerOracle };
    return { status: "done", answer, picks: answerPicks(answer, seen) };
  }
  if (isTimeout(result)) return { status: "failed", error: timeoutMessage(found, tier), offerOracle };
  if (result.status === "limit_reached") return { status: "failed", error: "The assistant ran out of steps. Try a more specific question.", offerOracle };
  const error = friendlyError(result.error ?? "The assistant failed.");
  // The user pressed Stop: no suggestion needed.
  if (error === "Aborted") return { status: "failed", error: "Stopped." };
  return { status: "failed", error, offerOracle };
}

/** The agent conversation: visible turns, the history sent with follow-ups, and Stop. */
export function useAssistantConversation(ask: (question: string, options: AskOptions) => Promise<AgentResult>, dev: DevLog, currentEntry: RefObject<number | null>) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const running = turns.at(-1)?.status === "running";
  const history = useRef<ChatMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const nextTurnId = useRef(1);

  const runAssistant = async (query: string, hints: SearchHints, logRules: (entry: number) => void, tier: "default" | "oracle" = "default") => {
    const question = query.trim();
    if (!question) return;
    const id = nextTurnId.current++;
    const update = (change: (t: Turn) => Turn) => setTurns((all) => all.map((t) => (t.id === id ? change(t) : t)));
    const note = tier === "oracle" ? `Oracle can take up to ${QUESTION_LIMIT_MS.oracle / 1000} s. Stop ends it early.` : undefined;
    setTurns((all) => [...all, { id, question, tier, note, timeline: [], steps: [], status: "running" }]);
    const toolStarts = new Map<string, { name: string; at: number }>();
    let lastEventAt = performance.now();
    let found: { title: string; year: number }[] = [];
    const seen = new Map<number, { id: number; title: string }>();
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
          const movies = e.type === "tool_result" ? (e.result as { movies?: { id: number; title: string; year: number }[] }).movies : undefined;
          if (movies?.length) found = movies;
          for (const m of movies ?? []) seen.set(m.id, m);
          lastEventAt = performance.now();
          const item = timelineItem(e, lastEventAt, toolStarts);
          if (item) update((t) => ({ ...t, timeline: [...t.timeline, item] }));
          const step = describeEvent(e);
          if (step) update((t) => ({ ...t, steps: [...t.steps, step] }));
          const devItem = devItemFor(e);
          if (devItem) dev.add(entry, devItem);
        },
      });
      if (result.status === "failed" || result.status === "timed_out") {
        // A model call that fails reports no event, but it did run and it took this long.
        const ms = Math.round(performance.now() - lastEventAt);
        update((t) => ({ ...t, timeline: [...t.timeline, { kind: "model", label: "Stopped", ms }] }));
        dev.add(entry, { stage: "assistant", label: "Stopped", detail: result.error ?? "time limit", ms, serverCall: true });
      }
      const outcome = turnOutcome(result, tier, found, [...seen.values()]);
      if (outcome.status === "done") history.current = result.transcript.filter((m) => m.role !== "system");
      update((t) => ({ ...t, ...outcome }));
    } catch (e) {
      update((t) => ({ ...t, status: "failed", error: friendlyError(e), offerOracle: tier === "default" }));
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
