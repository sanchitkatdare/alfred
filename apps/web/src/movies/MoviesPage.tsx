import { decideRoute, parse, type ChatMessage, type Chip, type ParserConfig, type Route } from "@alfred/agent-harness";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import tmdbLogo from "../../../../assets/tmdb.svg";
import { createEmbedClient, friendlyError } from "./api";
import { AssistantPanel, describeEvent, type Turn } from "./AssistantPanel";
import { createMovieAssistant } from "./assistant";
import type { CatalogMeta, Movie } from "./catalog";
import { buildMovieParserConfig, MOVIE_ROUTER_OPTIONS } from "./config";
import { loadCatalog, loadStories, loadSynopses, loadVectors } from "./data";
import { chipsToSearchHints } from "./hints";
import { byRating, filterCatalog } from "./tools";
import { useWatched } from "./useWatched";
import { rankByVector, vectorOf, type VectorIndex } from "./vectors";

const MAX_QUERY_CHARS = 300;

const EXAMPLES = [
  "a jennifer lawrence action movie",
  "movie with deNiro and pacino",
  "like inception but not sci-fi, under 2 hours",
  "mind-bending villeneuve film",
  "the one where a man tattoos clues on his body",
  "movie above 7 that does not have horror",
  "plan a movie night for me and a friend who hates horror",
];

const KIND_LABEL: Record<string, string> = {
  genre: "genre", actor: "actor", director: "director", runtime: "runtime", year: "year",
  rating: "rating", similar: "like", task: "task", user: "my data",
};

const ROUTES: Record<Route, { name: string; cost: string; detail: string }> = {
  local: { name: "Local filter", cost: "0 AI calls · no network", detail: "Rules matched every word. The list below updates as you type." },
  semantic: { name: "Search by meaning", cost: "1 embedding · 0 LLM · ≈ 0.1 s", detail: "Press Enter: the server turns the free text into a vector, and your browser ranks the filtered movies by meaning." },
  assistant: { name: "Assistant", cost: "2-5 LLM calls · ≈ 5-10 s", detail: "Press Enter: the assistant searches, reads and decides in up to 5 steps. You see each step." },
  empty: { name: "Waiting for input", cost: "", detail: "Type a request or pick an example." },
};

const formatRuntime = (min: number) => `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;

/** Adds two vectors after scaling each to length 1, so a movie and a phrase count equally. */
function blend(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const norm = (v: ArrayLike<number>) => Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0)) || 1;
  const na = norm(a), nb = norm(b);
  return Array.from(a, (x, i) => x / na + b[i]! / nb);
}

interface SemanticResult {
  query: string;
  movies: Movie[];
  ms: number;
}

function MovieSearch({ meta, catalog, config }: { meta: CatalogMeta; catalog: Movie[]; config: ParserConfig }) {
  const [query, setQuery] = useState(EXAMPLES[2]!);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const { watched, getWatched, markWatched, clear } = useWatched();
  const inputRef = useRef<HTMLInputElement>(null);
  const seenSigs = useRef<Set<string>>(new Set());
  const byId = useMemo(() => new Map(catalog.map((m) => [m.id, m])), [catalog]);

  // Search data loads after the page appears, so typing and filters work first.
  const vectorsRef = useRef<Promise<VectorIndex> | null>(null);
  const getVectors = useCallback(() => {
    if (!vectorsRef.current) {
      const p = loadVectors(meta);
      vectorsRef.current = p;
      p.catch(() => vectorsRef.current === p && (vectorsRef.current = null));
    }
    return vectorsRef.current;
  }, [meta]);
  const [synopses, setSynopses] = useState<Record<string, string>>({});
  useEffect(() => {
    const t = setTimeout(() => {
      getVectors().catch(() => {});
      loadSynopses().then(setSynopses).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [getVectors]);

  const embed = useMemo(() => createEmbedClient(), []);
  const search = useCallback(async (text: string, ids: number[]) => rankByVector(await getVectors(), await embed(text), ids), [embed, getVectors]);
  const ask = useMemo(
    () => createMovieAssistant({ catalog, getWatched, markWatched, search, details: loadStories }),
    [catalog, getWatched, markWatched, search],
  );

  const parsed = useMemo(() => parse(query, config), [query, config]);
  const chips = parsed.chips.filter((c) => !removed.has(c.sig));
  const decision = decideRoute({ chips, leftover: parsed.leftover }, MOVIE_ROUTER_OPTIONS);
  const deferredChips = useDeferredValue(chips);
  const live = useMemo(() => {
    // Same filter as the assistant's search_movies: chips become hard filters.
    const all = filterCatalog(catalog, { ...chipsToSearchHints(deferredChips), includeWatched: true }, watched).sort(byRating);
    const movies = all.filter((m) => !watched.has(m.id));
    return { movies, hiddenWatched: all.length - movies.length };
  }, [catalog, deferredChips, watched]);

  const fresh = new Set(chips.filter((c) => !seenSigs.current.has(c.sig)).map((c) => c.sig));
  seenSigs.current = new Set(chips.map((c) => c.sig));

  // Search by meaning
  const [semantic, setSemantic] = useState<SemanticResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const runSearch = async () => {
    setSearching(true);
    setSearchError(null);
    const started = performance.now();
    try {
      const similar = chips.find((c) => c.kind === "similar");
      const similarId = similar ? Number(similar.id) : null;
      const text = parsed.leftover.join(" ");
      const index = await getVectors();
      const movieVector = similarId !== null ? vectorOf(index, similarId) : null;
      const textVector = text ? await embed(text) : null;
      const queryVector = textVector && movieVector ? blend(textVector, movieVector) : (textVector ?? movieVector);
      if (!queryVector) return;
      const ids = filterCatalog(catalog, chipsToSearchHints(chips), watched).map((m) => m.id).filter((id) => id !== similarId);
      const ranked = rankByVector(index, queryVector, ids, 10);
      setSemantic({ query, movies: ranked.map((r) => byId.get(r.id)!), ms: Math.round(performance.now() - started) });
    } catch (e) {
      setSearchError(friendlyError(e));
    } finally {
      setSearching(false);
    }
  };

  // Assistant
  const [turns, setTurns] = useState<Turn[]>([]);
  const history = useRef<ChatMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const running = turns.at(-1)?.status === "running";
  const runAssistant = async () => {
    const question = query.trim();
    if (!question) return;
    const turnIndex = turns.length;
    const update = (change: (t: Turn) => Turn) => setTurns((all) => all.map((t, i) => (i === turnIndex ? change(t) : t)));
    setTurns((all) => [...all, { question, steps: [], status: "running" }]);
    abort.current = new AbortController();
    try {
      const result = await ask(question, {
        history: history.current,
        hints: chipsToSearchHints(chips),
        signal: abort.current.signal,
        onEvent: (e) => {
          const step = describeEvent(e);
          if (step) update((t) => ({ ...t, steps: [...t.steps, step] }));
        },
      });
      if (result.status === "done") {
        history.current = result.transcript.filter((m) => m.role !== "system");
        update((t) => ({ ...t, status: "done", answer: result.message?.content || "(no answer)" }));
      } else {
        const error = result.status === "limit_reached" ? "The assistant ran out of steps. Try a more specific question." : friendlyError(result.error ?? "The assistant failed.");
        update((t) => ({ ...t, status: "failed", error: error === "Aborted" ? "Stopped." : error }));
      }
    } catch (e) {
      update((t) => ({ ...t, status: "failed", error: friendlyError(e) }));
    }
  };
  const resetConversation = () => {
    history.current = [];
    setTurns([]);
  };

  const setText = (text: string) => {
    setQuery(text.slice(0, MAX_QUERY_CHARS));
    setRemoved(new Set());
    setSearchError(null);
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
  const busy = searching || running;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (decision.route === "assistant") void runAssistant();
    else if (decision.route === "semantic") void runSearch();
  };

  const route = ROUTES[decision.route];
  const showSemantic = semantic && semantic.query === query;
  const shown = showSemantic ? semantic.movies.filter((m) => !watched.has(m.id)) : live.movies.slice(0, 10);

  return (
    <main className="page">
      <header className="head">
        <h1>Alfred Movies</h1>
        <p className="muted">Type a request. Rules parse it in the browser as you type. Catalog of {catalog.length.toLocaleString()} movies from TMDB.</p>
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

        <form className="qbox" onSubmit={onSubmit}>
          <label htmlFor="q">Ask for a movie</label>
          <div className="qrow">
            <input id="q" ref={inputRef} type="text" autoComplete="off" spellCheck={false} maxLength={MAX_QUERY_CHARS} value={query} onChange={(e) => setText(e.target.value)} />
            {decision.route === "semantic" && <button type="submit" className="btn" disabled={busy}>{searching ? "Searching…" : "Search"}</button>}
            {decision.route !== "empty" && (
              <button type={decision.route === "assistant" ? "submit" : "button"} className={`btn ${decision.route === "assistant" ? "" : "ghost"}`} disabled={busy} onClick={decision.route === "assistant" ? undefined : () => void runAssistant()}>
                {running ? "Working…" : "Ask assistant"}
              </button>
            )}
          </div>
          {query.length >= MAX_QUERY_CHARS - 50 && <span className="note counter">{query.length}/{MAX_QUERY_CHARS} characters</span>}
          <div className="examples">
            <span className="eyebrow">Examples</span>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="ex" onClick={() => setText(ex)}>{ex}</button>
            ))}
          </div>
        </form>

        <AssistantPanel turns={turns} running={running} onStop={() => abort.current?.abort()} onReset={resetConversation} />

        <div className="grid">
          <div className="panel">
            <div className="panel-head">
              <h2>{showSemantic ? "Best matches by meaning" : "Results"}</h2>
              <span className="note">{showSemantic ? `ranked in ${semantic.ms} ms` : `${live.movies.length} of ${catalog.length} match`}</span>
            </div>
            {searchError && (
              <p className="answer failed dismissible" role="alert">
                <span>{searchError}</span>
                <button type="button" className="x" aria-label="Dismiss error" onClick={() => setSearchError(null)}>×</button>
              </p>
            )}
            <ul className="results">
              {shown.map((movie) => (
                <li key={movie.id}>
                  <span className="t">{movie.title}</span>
                  <button type="button" className="w" onClick={() => markWatched(movie.id)}>Mark watched</button>
                  <span className="m">{movie.year} · {formatRuntime(movie.runtime)} · ★ {movie.rating.toFixed(1)} · {movie.genres.join(", ")}</span>
                  {synopses[movie.id] && <span className="syn">{synopses[movie.id]}</span>}
                </li>
              ))}
              {!shown.length && <li><span className="empty">No movie matches these filters.</span></li>}
            </ul>
            {(live.hiddenWatched > 0 || watched.size > 0) && (
              <p className="note">
                {live.hiddenWatched > 0 && `${live.hiddenWatched} hidden because you marked them watched. `}
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

      <footer className="foot">
        <p><img src={tmdbLogo} alt="TMDB" height={10} /> This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <p>Search text and assistant questions are sent to Cloudflare Workers AI. Your watched list stays in this browser.</p>
      </footer>
    </main>
  );
}

type CatalogState = { status: "loading" } | { status: "missing" } | { status: "ready"; meta: CatalogMeta; catalog: Movie[]; config: ParserConfig };

/** Loads the seeded catalog, then shows the search. */
export function MoviesPage() {
  const [state, setState] = useState<CatalogState>({ status: "loading" });
  useEffect(() => {
    loadCatalog()
      .then(({ meta, catalog }) => setState({ status: "ready", meta, catalog, config: buildMovieParserConfig(catalog) }))
      .catch(() => setState({ status: "missing" }));
  }, []);

  if (state.status === "ready") return <MovieSearch meta={state.meta} catalog={state.catalog} config={state.config} />;
  return (
    <main className="page">
      <header className="head">
        <h1>Alfred Movies</h1>
        {state.status === "loading" ? (
          <p className="muted">Loading the movie catalog…</p>
        ) : (
          <p className="muted">The movie catalog is missing. Run <code>pnpm --filter @alfred/web seed --count 500</code> with <code>TMDB_TOKEN</code> in the repo-root <code>.env</code>.</p>
        )}
      </header>
    </main>
  );
}
