import type { AgentEvent } from "@alfred/agent-harness";

export interface Step {
  kind: "think" | "tool" | "result" | "fix" | "error";
  text: string;
}

export interface Turn {
  question: string;
  steps: Step[];
  status: "running" | "done" | "failed";
  answer?: string;
  error?: string;
}

const short = (value: unknown, max = 110) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** One line in the visible trace for each harness event. */
export function describeEvent(event: AgentEvent): Step | null {
  switch (event.type) {
    case "llm_request":
      return { kind: "think", text: `Step ${event.iteration}: model is thinking` };
    case "tool_call":
      return { kind: "tool", text: `${event.call.name} ${short(event.call.arguments)}` };
    case "tool_result": {
      const r = event.result as { movies?: unknown[]; matches?: number; marked?: { title: string } } | unknown[];
      const text = Array.isArray(r)
        ? `${r.length} item${r.length === 1 ? "" : "s"}`
        : r?.movies
          ? `${r.movies.length} movie${r.movies.length === 1 ? "" : "s"}${r.matches !== undefined ? ` of ${r.matches} matches` : ""}`
          : r?.marked
            ? `marked ${r.marked.title} as watched`
            : "done";
      return { kind: "result", text: `→ ${text}${event.cached ? " (repeat call, not run again)" : ""}` };
    }
    case "validation_error":
      return { kind: "fix", text: `Invalid tool call, sent back for correction: ${short(event.error.split("\n")[0], 140)}` };
    case "tool_error":
      return { kind: "error", text: event.error };
    case "limit_reached":
      return { kind: "error", text: `Stopped after ${event.iterations} steps` };
    default:
      return null;
  }
}

/** The model writes light Markdown; show it as plain text. */
const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "");

export function AssistantPanel({ turns, running, onStop, onReset }: { turns: Turn[]; running: boolean; onStop(): void; onReset(): void }) {
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
      {turns.map((t, i) => (
        <div key={i} className="turn">
          <p className="question">{t.question}</p>
          <ol className="steps">
            {t.steps.map((s, j) => <li key={j} className={`step ${s.kind}`}>{s.text}</li>)}
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
