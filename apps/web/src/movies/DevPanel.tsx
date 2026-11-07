import { readDailyNeurons, totals, type DevEntry, type DevItem, type Stage } from "./devlog";

/** Workers AI free allocation per day, for the whole account. */
const DAILY_NEURON_LIMIT = 10_000;

/** The same names and order as the pipeline line under the search bar. */
const STAGES: { id: Stage; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "rules", label: "1 · Rules" },
  { id: "search", label: "2 · Search" },
  { id: "assistant", label: "3 · AI" },
];
const PIPELINE: Stage[] = ["rules", "search", "assistant"];

const KIND_LABEL: Record<DevEntry["kind"], string> = { load: "Page load", lookup: "Lookup, no AI", search: "Search by meaning", assistant: "Assistant" };

export interface LiveRules {
  parseMs: number;
  route: { name: string; cost: string; detail: string; kind: string };
  reason: string;
  hints: object;
  trace: string[];
}

/** Filters in plain words: "genres: drama · languages: hi". */
export function describeHints(hints: object): string {
  return Object.entries(hints)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join(" · ");
}

const formatMs = (ms: number) => (ms < 1 ? "< 1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const stageMs = (items: DevItem[]) => items.reduce((sum, i) => sum + (i.ms ?? 0), 0);
const failed = (e: DevEntry) => e.items.some((i) => /error|stopped|limit reached/i.test(i.label));

function summary(e: DevEntry) {
  const t = totals(e);
  const time = e.ms === undefined ? "running…" : formatMs(e.ms);
  return `${time} · ${t.serverCalls} server call${t.serverCalls === 1 ? "" : "s"} · ${t.neurons.toFixed(2)} neurons`;
}

/** Where the time went: one bar per pipeline stage, placed one after another, in the stage colors. */
function Waterfall({ entry }: { entry: DevEntry }) {
  const rows = PIPELINE.map((id) => ({ id, ms: stageMs(entry.items.filter((i) => i.stage === id)), used: entry.items.some((i) => i.stage === id) }));
  const total = Math.max(1, entry.ms ?? 0, rows.reduce((s, r) => s + r.ms, 0));
  let offset = 0;
  return (
    <ol className="waterfall" aria-label="Time per stage">
      {rows.map((r) => {
        const left = offset;
        offset += r.ms;
        const label = STAGES.find((s) => s.id === r.id)!.label.replace(/^\d · /, "");
        return (
          <li key={r.id} className={`stage-${r.id}${r.used ? " ran" : ""}`}>
            <span>{label}</span>
            <span className="waterfall-track">{r.used && <span className="waterfall-bar" style={{ left: `${(left / total) * 100}%`, width: `max(2px, ${(r.ms / total) * 100}%)` }} />}</span>
            <span className="waterfall-ms">{r.used ? formatMs(r.ms) : "not used"}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** One section per stage, in pipeline order: what it did, in plain words. Unused stages say so. */
function Stages({ entry }: { entry: DevEntry }) {
  const ids = entry.kind === "load" ? STAGES.map((s) => s.id).filter((id) => entry.items.some((i) => i.stage === id)) : PIPELINE;
  return (
    <>
      {ids.map((id) => {
        const items = entry.items.filter((i) => i.stage === id);
        const label = STAGES.find((s) => s.id === id)!.label;
        if (!items.length) return <p key={id} className={`dev-section unused stage-${id}`}>{label}: not used</p>;
        return (
          <section key={id} className={`dev-section stage-${id}`}>
            <h4>{label}</h4>
            <ul>
              {items.map((i, n) => (
                <li key={n}>
                  <span className="dev-label">{i.label}</span>
                  {(i.ms !== undefined || i.neurons !== undefined) && (
                    <span className="dev-metrics">{[i.ms !== undefined && formatMs(i.ms), i.neurons !== undefined && `${i.neurons.toFixed(2)} neurons`].filter(Boolean).join(" · ")}</span>
                  )}
                  {i.detail && <span className="dev-detail">{i.detail}</span>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/** Dev mode: what happens to your words now, then the latest request stage by stage, then usage and earlier requests. */
export function DevPanel({ live, entries }: { live: LiveRules; entries: DevEntry[] }) {
  const latest = entries.find((e) => e.kind !== "load");
  const earlier = entries.filter((e) => e !== latest);
  const today = readDailyNeurons();
  return (
    <aside className="dev" aria-label="Dev mode">
      <h2>Under the hood</h2>

      <section className="dev-now" aria-label="As you type">
        <div className="dev-now-head">
          <span className="eyebrow">As you type</span>
          <span className={`route-badge ${live.route.kind}`}>{live.route.name}</span>
        </div>
        <p>{live.reason}. {live.route.detail}</p>
        <p className="dev-meta">Parsed in {formatMs(live.parseMs)}{Object.keys(live.hints).length ? ` · ${describeHints(live.hints)}` : " · no filters"}</p>
        {live.trace.length > 0 && (
          <details className="dev-raw">
            <summary>How the words were read</summary>
            <ul className="trace">{live.trace.map((t, i) => <li key={i}>{t}</li>)}</ul>
            {Object.keys(live.hints).length > 0 && <code>{JSON.stringify(live.hints)}</code>}
          </details>
        )}
      </section>

      {latest ? (
        <section className="dev-card" aria-label="This request">
          <div className="dev-now-head">
            <span className="eyebrow">This request</span>
            <span className={`route-badge ${latest.kind}`}>{KIND_LABEL[latest.kind]}</span>
          </div>
          <p className="dev-title">{latest.title}</p>
          <p className="dev-meta">{summary(latest)}{failed(latest) ? " · failed" : ""}</p>
          <Waterfall entry={latest} />
          <Stages entry={latest} />
        </section>
      ) : (
        <p className="note">Press Enter to see each stage of a request here.</p>
      )}

      <section className="cost-meter" aria-label="Usage today">
        <div className="cost-row"><span>Today, this browser (estimate)</span><span>{today.toFixed(1)} of {DAILY_NEURON_LIMIT.toLocaleString()} free neurons</span></div>
        <span className="cost-track"><span className="cost-bar" style={{ width: `${Math.min(100, (today / DAILY_NEURON_LIMIT) * 100)}%` }} /></span>
      </section>

      {earlier.length > 0 && (
        <section aria-label="Earlier requests">
          <h3>Earlier</h3>
          {earlier.map((e) => (
            <details key={e.id} className="dev-earlier">
              <summary>
                <span className="dev-earlier-title">{e.title}</span>
                <span className="dev-meta">{KIND_LABEL[e.kind]} · {e.ms === undefined ? "running…" : formatMs(e.ms)}{failed(e) ? " · failed" : ""}</span>
              </summary>
              <p className="dev-meta">{summary(e)}</p>
              {e.kind !== "load" && <Waterfall entry={e} />}
              <Stages entry={e} />
            </details>
          ))}
        </section>
      )}
    </aside>
  );
}
