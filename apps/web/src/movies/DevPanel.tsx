import { totals, type DevEntry, type Stage } from "./devlog";

const STAGE_LABEL: Record<Stage, string> = { data: "Data", rules: "1 · Rules", search: "2 · Search", assistant: "3 · Assistant" };

export interface LiveRules {
  parseMs: number;
  route: { name: string; cost: string; detail: string; kind: string };
  reason: string;
  hints: object;
}

/** Dev mode: the pipeline as it runs, with timings and cost per stage. */
export function DevPanel({ live, entries }: { live: LiveRules; entries: DevEntry[] }) {
  return (
    <aside className="dev" aria-label="Dev mode">
      <h2>Under the hood</h2>
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
