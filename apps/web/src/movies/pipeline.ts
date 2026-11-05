import type { DevEntry, Stage } from "./devlog";

export interface PipelineStage {
  id: "rules" | "search" | "assistant";
  label: string;
  /** Hover note: what the stage does, in a few words. */
  hint: string;
  ran: boolean;
  time: string;
}

const formatMs = (ms: number) => (ms < 1 ? "< 1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Rules run on every keystroke. Search and AI count as used only when the latest request for this text reached them. */
export function pipelineStages(entry: DevEntry | null, parseMs: number): PipelineStage[] {
  const stage = (id: Stage & PipelineStage["id"], label: string, hint: string): PipelineStage => {
    const items = entry?.items.filter((i) => i.stage === id) ?? [];
    return { id, label, hint, ran: items.length > 0, time: formatMs(items.reduce((sum, i) => sum + (i.ms ?? 0), 0)) };
  };
  return [
    { id: "rules", label: "Rules", hint: "Matches words to genres, people, years and runtimes in your browser. No AI.", ran: true, time: formatMs(parseMs) },
    stage("search", "Search", "Turns free text into a vector on the server, then ranks movies by meaning in your browser."),
    stage("assistant", "AI", "A language model calls our movie tools to answer questions. Slowest stage."),
  ];
}
