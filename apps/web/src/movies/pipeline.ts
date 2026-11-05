import type { DevEntry, Stage } from "./devlog";

export interface PipelineStage {
  id: "rules" | "search" | "assistant";
  label: string;
  /** Popup: the stage as a few steps, and where it runs. */
  flow: string[];
  note: string;
  ran: boolean;
  time: string;
}

const formatMs = (ms: number) => (ms < 1 ? "< 1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Rules run on every keystroke. Search and AI count as used only when the latest request for this text reached them. */
export function pipelineStages(entry: DevEntry | null, parseMs: number): PipelineStage[] {
  const stage = (id: Stage & PipelineStage["id"], label: string, flow: string[], note: string): PipelineStage => {
    const items = entry?.items.filter((i) => i.stage === id) ?? [];
    return { id, label, flow, note, ran: items.length > 0, time: formatMs(items.reduce((sum, i) => sum + (i.ms ?? 0), 0)) };
  };
  return [
    { id: "rules", label: "Rules", flow: ["Your words", "Dictionary", "Filters"], note: "In your browser, every keystroke. No AI.", ran: true, time: formatMs(parseMs) },
    stage("search", "Search", ["Free text", "Vector", "Rank by meaning"], "1 embedding call on the server; ranking in your browser."),
    stage("assistant", "AI", ["Question", "Model picks tools", "Tools run", "Answer"], "Language model on the server. Slowest stage."),
  ];
}
