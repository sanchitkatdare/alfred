import type { AgentEvent } from "@alfred/agent-harness";
import { short } from "./devlog";

export interface Step {
  kind: "think" | "tool" | "result" | "fix" | "error";
  text: string;
}

/** One model or tool call in the timeline. */
export interface TimelineItem {
  kind: "model" | "tool";
  label: string;
  ms: number;
  neurons?: number;
}

/** Turns harness events into timeline items. `starts` holds tool start times between calls. */
export function timelineItem(event: AgentEvent, now: number, starts: Map<string, { name: string; at: number }>): TimelineItem | null {
  switch (event.type) {
    case "llm_response":
      return { kind: "model", label: `Model ${event.iteration}`, ms: event.ms, neurons: event.usage?.neurons };
    case "tool_call":
      starts.set(event.call.id, { name: event.call.name, at: now });
      return null;
    case "tool_result": {
      const start = starts.get(event.callId);
      return start ? { kind: "tool", label: start.name, ms: Math.round(now - start.at) } : null;
    }
    default:
      return null;
  }
}

export interface Turn {
  id: number;
  question: string;
  /** Shown from the start of the turn, for example how long Oracle can take. */
  note?: string;
  timeline: TimelineItem[];
  steps: Step[];
  status: "running" | "done" | "failed";
  answer?: string;
  error?: string;
}

/** One line in the visible trace for each harness event. */
export function describeEvent(event: AgentEvent): Step | null {
  switch (event.type) {
    case "llm_request":
      return { kind: "think", text: `Step ${event.iteration}: model is thinking` };
    case "tool_call":
      return { kind: "tool", text: `${event.call.name} ${short(event.call.arguments)}` };
    case "tool_result": {
      const r = event.result as { movies?: unknown[]; matches?: number } | unknown[];
      const text = Array.isArray(r)
        ? `${r.length} item${r.length === 1 ? "" : "s"}`
        : r?.movies
          ? `${r.movies.length} movie${r.movies.length === 1 ? "" : "s"}${r.matches !== undefined ? ` of ${r.matches} matches` : ""}`
          : "done";
      return { kind: "result", text: `→ ${text}${event.cached ? " (repeat call, not run again)" : ""}` };
    }
    case "validation_error":
      return { kind: "fix", text: `Invalid tool call, sent back for correction: ${short(event.error.split("\n")[0], 140)}` };
    case "tool_error":
      return { kind: "error", text: event.error };
    case "limit_reached":
      return { kind: "error", text: `Stopped after ${event.iterations} steps` };
    case "timed_out":
      return { kind: "error", text: `Stopped after ${event.ms / 1000} s` };
    default:
      return null;
  }
}

/** The model writes light Markdown; show it as plain text. */
const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "");

function Timeline({ items }: { items: TimelineItem[] }) {
  if (!items.length) return null;
  const max = Math.max(1, ...items.map((i) => i.ms));
  return (
    <ol className="timeline">
      {items.map((item, i) => (
        <li key={i} className={item.kind}>
          <span className="timeline-label">{item.label}</span>
          <span className="timeline-track"><span className="timeline-bar" style={{ width: `${(item.ms / max) * 100}%` }} /></span>
          <span className="timeline-value">{item.ms} ms{item.neurons !== undefined ? ` · ${item.neurons.toFixed(1)} neurons` : ""}</span>
        </li>
      ))}
    </ol>
  );
}

export function AssistantPanel({ turns, running, devMode, onStop, onReset }: { turns: Turn[]; running: boolean; devMode: boolean; onStop(): void; onReset(): void }) {
  if (!turns.length) return null;
  return (
    <section className="assistant" aria-label="Assistant" aria-live="polite">
      <div className="panel-head">
        <h2>Assistant</h2>
        <div className="actions">
          {running && <button type="button" className="btn ghost" onClick={onStop}>Stop</button>}
          {!running && <button type="button" className="btn ghost" onClick={onReset}>New conversation</button>}
        </div>
      </div>
      {turns.map((t) => (
        <div key={t.id} className="turn">
          <p className="question">{t.question}</p>
          {t.note && <p className="note">{t.note}</p>}
          <Timeline items={t.timeline} />
          <ol className="steps">
            {t.steps.filter((s) => devMode || s.kind === "error").map((s, j) => <li key={j} className={`step ${s.kind}`}>{s.text}</li>)}
            {t.status === "running" && <li className="step think">Working…</li>}
          </ol>
          {t.answer && <p className="answer">{plain(t.answer)}</p>}
          {t.error && <p className="answer failed">{t.error}</p>}
        </div>
      ))}
      <p className="note">Follow-up questions continue this conversation.</p>
    </section>
  );
}
