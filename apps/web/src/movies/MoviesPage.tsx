import { decideRoute, parse, type Chip, type Route } from "@alfred/agent-harness";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { SAMPLE_CATALOG } from "./catalog";
import { buildMovieParserConfig, MOVIE_ROUTER_OPTIONS } from "./config";
import { filterMovies } from "./filter";
import { useWatched } from "./useWatched";

const config = buildMovieParserConfig(SAMPLE_CATALOG);

const EXAMPLES = [
  "a jennifer lawrence action movie",
  "movie with deNiro and pacino",
  "like inception but not sci-fi, under 2 hours",
  "movie above 7 that does not have horror",
  "crime without de niro, at least 2 hours",
  "mind-bending villeneuve film",
  "hemsworth action",
  "jenifer lawrance comedy",
  "plan a movie night for me and a friend who hates horror",
];

const KIND_LABEL: Record<string, string> = {
  genre: "genre", actor: "actor", director: "director", runtime: "runtime", year: "year",
  rating: "rating", similar: "like", task: "task", user: "my data",
};

const ROUTES: Record<Route, { name: string; cost: string; detail: string }> = {
  local: { name: "Local filter", cost: "0 AI calls · no network · < 10 ms", detail: "Rules matched every word. The browser filters the catalog. This list is the final result." },
  semantic: { name: "Semantic search", cost: "1 embedding · 0 LLM · ≈ 0.1-0.3 s", detail: "On submit, the server embeds the free text and searches vectors, with the chips as filters. Not connected yet." },
  assistant: { name: "Assistant", cost: "2-5 LLM calls · ≈ 3-7 s", detail: "A task needs the agent loop. The movies below go to the assistant as tool output. Not connected yet." },
  empty: { name: "Waiting for input", cost: "", detail: "Type a request or pick an example." },
};

const formatRuntime = (min: number) => `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;

export function MoviesPage() {
  const [query, setQuery] = useState(EXAMPLES[2]!);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const { watched, markWatched, clear } = useWatched();
  const inputRef = useRef<HTMLInputElement>(null);
  const seenSigs = useRef<Set<string>>(new Set());

  const parsed = useMemo(() => parse(query, config), [query]);
  const chips = parsed.chips.filter((c) => !removed.has(c.sig));
  const decision = decideRoute({ chips, leftover: parsed.leftover }, MOVIE_ROUTER_OPTIONS);
  const deferredChips = useDeferredValue(chips);
  const result = useMemo(() => filterMovies(SAMPLE_CATALOG, deferredChips, watched), [deferredChips, watched]);

  const fresh = new Set(chips.filter((c) => !seenSigs.current.has(c.sig)).map((c) => c.sig));
  seenSigs.current = new Set(chips.map((c) => c.sig));

  const setText = (text: string) => {
    setQuery(text);
    setRemoved(new Set());
  };
  const removeChip = (chip: Chip) => {
    setRemoved(new Set([...removed, chip.sig]));
    inputRef.current?.focus();
  };
  const acceptSuggestion = () => {
    const s = parsed.suggestion;
    if (!s) return;
    const escaped = s.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    setText(query.replace(new RegExp(`${escaped}\\s*$`, "i"), `${s.to} `));
    inputRef.current?.focus();
  };

  const route = ROUTES[decision.route];

  return (
    <main className="page">
      <header className="head">
        <h1>Alfred Movies</h1>
        <p className="muted">Type a request. Rules parse it in the browser as you type. Sample catalog of {SAMPLE_CATALOG.length} movies.</p>
      </header>

      <section className="sim" aria-label="Movie search">
        <div className="understood">
          <span className="eyebrow">Understood so far · select × to remove</span>
          <div className="chips" aria-live="polite">
            {chips.map((c) => {
              const kind = `${c.negate ? "not " : ""}${KIND_LABEL[c.kind] ?? c.kind}`;
              const cls = ["chip", c.negate && "neg", c.kind === "task" && "task", fresh.has(c.sig) && "new"].filter(Boolean).join(" ");
              return (
                <span key={c.sig} className={cls}>
                  <span className="kind">{kind}</span>
                  <span className="val">{c.label}</span>
                  {c.fuzzy && <span className="flag" title="Matched with typo tolerance">≈</span>}
                  {c.ambiguous && <span className="flag" title={`Also: ${c.alts.join(", ")}`}>?</span>}
                  <button type="button" className="x" aria-label={`Remove ${kind} ${c.label}`} onClick={() => removeChip(c)}>×</button>
                </span>
              );
            })}
            {parsed.leftover.map((w, i) => (
              <span key={`${w}-${i}`} className="chip free"><span className="kind">free text</span><span className="val">{w}</span></span>
            ))}
            {parsed.suggestion && (
              <button type="button" className="chip suggest" onClick={acceptSuggestion}>
                <span className="kind">complete</span><span className="val">{parsed.suggestion.to}?</span>
              </button>
            )}
            {!chips.length && !parsed.leftover.length && !parsed.suggestion && <span className="placeholder">Chips appear here as you type.</span>}
          </div>
        </div>

        <div className="qbox">
          <label htmlFor="q">Ask for a movie</label>
          <input id="q" ref={inputRef} type="text" autoComplete="off" spellCheck={false} value={query} onChange={(e) => setText(e.target.value)} />
          <div className="examples">
            <span className="eyebrow">Examples</span>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="ex" onClick={() => setText(ex)}>{ex}</button>
            ))}
          </div>
        </div>

        <div className="grid">
          <div className="panel">
            <div className="panel-head">
              <h2>Results</h2>
              <span className="note">{result.movies.length} of {SAMPLE_CATALOG.length} match</span>
            </div>
            <ul className="results">
              {result.movies.slice(0, 10).map((movie) => (
                <li key={movie.id}>
                  <span className="t">{movie.title}</span>
                  <button type="button" className="w" onClick={() => markWatched(movie.id)}>Mark watched</button>
                  <span className="m">{movie.year} · {formatRuntime(movie.runtime)} · ★ {movie.rating.toFixed(1)} · {movie.genres.join(", ")}</span>
                </li>
              ))}
              {!result.movies.length && <li><span className="empty">No sample movie matches these filters.</span></li>}
            </ul>
            {(result.hiddenWatched > 0 || watched.size > 0) && (
              <p className="note">
                {result.hiddenWatched > 0 && `${result.hiddenWatched} hidden because you marked them watched. `}
                {watched.size > 0 && <button type="button" className="linkish" onClick={clear}>Clear watched list ({watched.size})</button>}
              </p>
            )}
          </div>

          <div className="panel">
            <h2>Route</h2>
            <div className={`route ${decision.route}`}>
              <div className="name">{route.name}</div>
              {route.cost && <div className="cost">{route.cost}</div>}
              <p>{decision.reason}. {route.detail}</p>
            </div>
            <h2>Parser trace</h2>
            <ul className="trace">
              {parsed.trace.length ? parsed.trace.map((t, i) => <li key={i}>{t}</li>) : <li>Nothing parsed yet.</li>}
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}
