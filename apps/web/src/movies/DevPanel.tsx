import { readDailyNeurons, totals, type DevEntry, type Stage } from "./devlog";

/** Workers AI free allocation per day, for the whole account. */
const DAILY_NEURON_LIMIT = 10_000;

const STAGE_LABEL: Record<Stage, string> = { data: "Data", rules: "1 · Rules", search: "2 · Search", assistant: "3 · Assistant" };

export interface LiveRules {
  parseMs: number;
  route: { name: string; cost: string; detail: string; kind: string };
  reason: string;
  hints: object;
  trace: string[];
}

/** Dev mode: the pipeline as it runs, with timings and cost per stage. */
export function DevPanel({ live, entries }: { live: LiveRules; entries: DevEntry[] }) {
  const latest = entries.find((e) => e.kind !== "load");
  const today = readDailyNeurons();
  return (
    <aside className="dev" aria-label="Dev mode">
      <h2>Under the hood</h2>
      <section className="cost-meter" aria-label="Cost">
        <div className="cost-row"><span>This request</span><span>{latest ? totals(latest).neurons.toFixed(2) : "0.00"} neurons</span></div>
        <div className="cost-row"><span>Today, this browser (estimate)</span><span>{today.toFixed(1)} of {DAILY_NEURON_LIMIT.toLocaleString()}</span></div>
        <span className="cost-track"><span className="cost-bar" style={{ width: `${Math.min(100, (today / DAILY_NEURON_LIMIT) * 100)}%` }} /></span>
      </section>
      <section className="dev-live">
        <div className="dev-stage">{STAGE_LABEL.rules} · as you type</div>
        <div className={`route ${live.route.kind}`}>
          <div className="name">{live.route.name}</div>
          {live.route.cost && <div className="cost">{live.route.cost}</div>}
          <p>{live.reason}. {live.route.detail}</p>
        </div>
        <dl className="dev-kv">
          <dt>Parse time</dt><dd>{live.parseMs.toFixed(2)} ms</dd>
          <dt>Hard filters</dt><dd><code>{Object.keys(live.hints).length ? JSON.stringify(live.hints) : "none"}</code></dd>
        </dl>
      </section>
      <ul className="trace">
        {live.trace.length ? live.trace.map((t, i) => <li key={i}>{t}</li>) : <li>Nothing parsed yet.</li>}
      </ul>
      <h3>Requests</h3>
      {!entries.length && <p className="note">Run a search or ask the assistant to see each stage here.</p>}
      {entries.map((e) => {
        const t = totals(e);
        return (
          <section key={e.id} className="dev-entry">
            <div className="dev-entry-head">
              <span className="dev-kind">{e.kind}</span>
              <span className="dev-title">{e.title}</span>
            </div>
            <ol className="dev-items">
              {e.items.map((i, n) => (
                <li key={n}>
                  <span className={`dev-stage-tag ${i.stage}`}>{STAGE_LABEL[i.stage]}</span>
                  <span className="dev-label">{i.label}</span>
                  {i.detail && <span className="dev-detail">{i.detail}</span>}
                  <span className="dev-metrics">
                    {i.ms !== undefined && `${i.ms} ms`}
                    {i.neurons !== undefined && ` · ${i.neurons.toFixed(2)} neurons`}
                  </span>
                </li>
              ))}
            </ol>
            <div className="dev-total">
              {e.ms === undefined ? "running…" : `${e.ms} ms total`} · {t.serverCalls} server call{t.serverCalls === 1 ? "" : "s"} · {t.neurons.toFixed(2)} neurons
            </div>
          </section>
        );
      })}
    </aside>
  );
}
