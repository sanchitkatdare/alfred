import { decideRoute, parse, type AgentEvent, type ChatMessage, type Chip, type ParserConfig, type Route } from "@alfred/agent-harness";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import tmdbLogo from "../../../../assets/tmdb.svg";
import { createEmbedClient, friendlyError } from "./api";
import { DevPanel } from "./DevPanel";
import { useDevLog, type DevLog } from "./devlog";
import { AssistantPanel, describeEvent, type Turn } from "./AssistantPanel";
import { createMovieAssistant } from "./assistant";
import type { CatalogMeta, Movie } from "./catalog";
import { buildMovieParserConfig, MOVIE_ROUTER_OPTIONS } from "./config";
import { loadCatalog, loadStories, loadSynopses, loadVectors } from "./data";
import { isFollowUp } from "./followups";
import { chipsToSearchHints } from "./hints";
import { byRating, filterCatalog } from "./tools";
import { useWatched } from "./useWatched";
import { rankByVector, scoreParts, vectorOf, type VectorIndex } from "./vectors";

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
  local: { name: "Local filter", cost: "0 AI calls · no network", detail: "The list below updates as you type; Search changes nothing." },
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

const short = (value: unknown, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Dev-mode line for each harness event; null for events the dev log does not show. */
function devItemFor(e: AgentEvent) {
  switch (e.type) {
    case "llm_response":
      return {
        stage: "assistant" as const,
        label: `Model call ${e.iteration}`,
        detail: `${e.toolCalls} tool call${e.toolCalls === 1 ? "" : "s"}${e.usage ? ` · ${e.usage.inputTokens} in / ${e.usage.outputTokens} out tokens` : ""}`,
        ms: e.ms,
        neurons: e.usage?.neurons,
        serverCall: true,
      };
    case "tool_call":
      return { stage: "assistant" as const, label: `Tool: ${e.call.name}`, detail: `model asked for ${short(e.call.arguments)}` };
    case "tool_result":
      return { stage: "assistant" as const, label: "Tool result", detail: `${e.chars} characters sent to the model${e.truncated ? ", truncated" : ""}${e.cached ? ", repeat call (not run)" : ""}` };
    case "validation_error":
      return { stage: "assistant" as const, label: "Invalid tool call, sent back", detail: short(e.error.split("\n")[0]) };
    case "tool_error":
      return { stage: "assistant" as const, label: "Tool error", detail: e.error };
    case "limit_reached":
      return { stage: "assistant" as const, label: "Step limit reached", detail: `${e.iterations} model calls` };
    default:
      return null;
  }
}

interface SemanticResult {
  query: string;
  movies: Movie[];
  ms: number;
}

interface MovieSearchProps {
  meta: CatalogMeta;
  catalog: Movie[];
  config: ParserConfig;
  dev: DevLog;
  loadEntry: number | null;
  devMode: boolean;
  onToggleDev(): void;
}

function MovieSearch({ meta, catalog, config, dev, loadEntry, devMode, onToggleDev }: MovieSearchProps) {
  const [query, setQuery] = useState(EXAMPLES[2]!);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const { watched, getWatched, markWatched, clear } = useWatched();
  const inputRef = useRef<HTMLInputElement>(null);
  const seenSigs = useRef<Set<string>>(new Set());
  const byId = useMemo(() => new Map(catalog.map((m) => [m.id, m])), [catalog]);

  // Search data loads after the page appears, so typing and filters work first.
  const vectorsRef = useRef<Promise<VectorIndex> | null>(null);
  const reportLoad = useCallback(
    (file: string, bytes: number, ms: number) => dev.add(loadEntry, { stage: "data", label: file, detail: `${(bytes / 1e6).toFixed(2)} MB`, ms }),
    [dev, loadEntry],
  );
  const getVectors = useCallback(() => {
    if (!vectorsRef.current) {
      const p = loadVectors(meta, reportLoad);
      vectorsRef.current = p;
      p.catch(() => vectorsRef.current === p && (vectorsRef.current = null));
    }
    return vectorsRef.current;
  }, [meta, reportLoad]);
  const [synopses, setSynopses] = useState<Record<string, string>>({});
  useEffect(() => {
    const t = setTimeout(() => {
      void Promise.allSettled([getVectors(), loadSynopses(reportLoad).then(setSynopses)]).then(() => loadEntry !== null && dev.finish(loadEntry));
    }, 300);
    return () => clearTimeout(t);
  }, [getVectors, reportLoad, dev, loadEntry]);

  // The dev-log entry that background reports (embedding, tool searches) belong to.
  const currentEntry = useRef<number | null>(null);

  const embed = useMemo(
    () => createEmbedClient(undefined, (r) => dev.add(currentEntry.current, { stage: "search", label: r.cached ? "Query vector from browser cache" : "Query vector from server", detail: `"${short(r.text, 60)}"${r.neurons !== undefined ? " · neurons estimated from tokens" : ""}`, ms: r.ms, neurons: r.neurons, serverCall: !r.cached })),
    [dev],
  );
  const search = useCallback(async (text: string, ids: number[]) => rankByVector(await getVectors(), await embed(text), ids), [embed, getVectors]);
  const ask = useMemo(
    () =>
      createMovieAssistant({
        catalog, getWatched, markWatched, search, details: loadStories,
        onSearch: (r) =>
          dev.add(currentEntry.current, {
            stage: "search",
            label: "search_movies filters",
            detail: `model: ${short(r.modelArgs, 120)} → applied after hints: ${short(r.appliedArgs, 120)} · ${r.matches} matches, ${r.returned} returned`,
            ms: r.ms,
          }),
      }),
    [catalog, getWatched, markWatched, search, dev],
  );

  const [turns, setTurns] = useState<Turn[]>([]);
  const running = turns.at(-1)?.status === "running";
  const { parsed, parseMs } = useMemo(() => {
    const started = performance.now();
    const result = parse(query, config);
    return { parsed: result, parseMs: performance.now() - started };
  }, [query, config]);
  const chips = parsed.chips.filter((c) => !removed.has(c.sig));
  const ruleDecision = decideRoute({ chips, leftover: parsed.leftover }, MOVIE_ROUTER_OPTIONS);
  // Rule A: during a conversation, words that refer back ("those", "shorter") make it a follow-up for the assistant.
  const [ignoreFollowUp, setIgnoreFollowUp] = useState(false);
  const followUp = !ignoreFollowUp && ruleDecision.route !== "assistant" && turns.some((t) => t.status === "done") && isFollowUp(query);
  const decision: { route: Route; reason: string } = followUp ? { route: "assistant", reason: "Follow-up to the conversation" } : ruleDecision;
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
  const logRules = (id: number) => {
    dev.add(id, { stage: "rules", label: `Route: ${decision.route}`, detail: `${decision.reason} · parsed in ${parseMs.toFixed(2)} ms` });
    const hints = chipsToSearchHints(chips);
    if (Object.keys(hints).length) dev.add(id, { stage: "rules", label: "Hard filters from chips", detail: short(hints) });
  };
  const runSearch = async () => {
    setSearching(true);
    setSearchError(null);
    const started = performance.now();
    const entry = dev.start("search", query);
    currentEntry.current = entry;
    logRules(entry);
    try {
      const similar = chips.find((c) => c.kind === "similar");
      const similarId = similar ? Number(similar.id) : null;
      const text = parsed.leftover.join(" ");
      const index = await getVectors();
      const movieVector = similarId !== null ? vectorOf(index, similarId) : null;
      const textVector = text ? await embed(text) : null;
      const queryVector = textVector && movieVector ? blend(textVector, movieVector) : (textVector ?? movieVector);
      if (!queryVector) return;
      if (movieVector) dev.add(entry, { stage: "search", label: "Movie vector", detail: `stored vector of ${byId.get(similarId!)?.title}, no server call` });
      const ids = filterCatalog(catalog, chipsToSearchHints(chips), watched).map((m) => m.id).filter((id) => id !== similarId);
      dev.add(entry, { stage: "search", label: "Filters", detail: `${ids.length.toLocaleString()} of ${catalog.length.toLocaleString()} movies left` });
      const rankStarted = performance.now();
      const ranked = rankByVector(index, queryVector, ids, 10);
      dev.add(entry, { stage: "search", label: "Ranking in the browser", detail: `${ids.length.toLocaleString()} vectors`, ms: Math.round(performance.now() - rankStarted) });
      dev.add(entry, {
        stage: "search",
        label: "Top results (meaning + popularity)",
        detail: ranked.slice(0, 5).map((r) => {
          const p = scoreParts(index, r.id, r.score);
          return `${byId.get(r.id)?.title} ${p.similarity.toFixed(2)}+${p.bonus.toFixed(2)}`;
        }).join(" · "),
      });
      setSemantic({ query, movies: ranked.map((r) => byId.get(r.id)!), ms: Math.round(performance.now() - started) });
    } catch (e) {
      setSearchError(friendlyError(e));
      dev.add(entry, { stage: "search", label: "Error", detail: friendlyError(e) });
    } finally {
      setSearching(false);
      dev.finish(entry);
      currentEntry.current = null;
    }
  };

  // Assistant
  const history = useRef<ChatMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const runAssistant = async () => {
    const question = query.trim();
    if (!question) return;
    const turnIndex = turns.length;
    const update = (change: (t: Turn) => Turn) => setTurns((all) => all.map((t, i) => (i === turnIndex ? change(t) : t)));
    setTurns((all) => [...all, { question, steps: [], status: "running" }]);
    abort.current = new AbortController();
    const entry = dev.start("assistant", question);
    currentEntry.current = entry;
    logRules(entry);
    try {
      const result = await ask(question, {
        history: history.current,
        hints: chipsToSearchHints(chips),
        signal: abort.current.signal,
        onEvent: (e) => {
          const step = describeEvent(e);
          if (step) update((t) => ({ ...t, steps: [...t.steps, step] }));
          const item = devItemFor(e);
          if (item) dev.add(entry, item);
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
    } finally {
      dev.finish(entry);
      currentEntry.current = null;
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
    setIgnoreFollowUp(false);
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
    <main className={`page${devMode ? " with-dev" : ""}`}>
      <header className="head">
        <div className="head-row">
          <h1>Alfred Movies</h1>
          <button type="button" className="btn ghost dev-toggle" aria-pressed={devMode} onClick={onToggleDev}>
            Dev mode: {devMode ? "on" : "off"}
          </button>
        </div>
        <p className="muted">Type a request. Rules parse it in the browser as you type. Catalog of {catalog.length.toLocaleString()} movies from TMDB.</p>
      </header>

      <div className="layout">
      <div className="main-col">
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
            {followUp && (
              <span className="chip task">
                <span className="kind">task</span><span className="val">follow-up</span>
                <button type="button" className="x" aria-label="Remove follow-up" onClick={() => setIgnoreFollowUp(true)}>×</button>
              </span>
            )}
            {parsed.leftover.map((w, i) => (
              <span key={`${w}-${i}`} className="chip free"><span className="kind">free text</span><span className="val">{w}</span></span>
            ))}
            {parsed.suggestion && (
              <button type="button" className="chip suggest" onClick={acceptSuggestion}>
                <span className="kind">complete</span><span className="val">{parsed.suggestion.to}?</span>
              </button>
            )}
            {!chips.length && !followUp && !parsed.leftover.length && !parsed.suggestion && <span className="placeholder">Chips appear here as you type.</span>}
          </div>
        </div>

        <form className="qbox" onSubmit={onSubmit}>
          <label htmlFor="q">Ask for a movie</label>
          <div className="qrow">
            <input id="q" ref={inputRef} type="text" autoComplete="off" spellCheck={false} maxLength={MAX_QUERY_CHARS} value={query} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="btn" disabled={busy || decision.route === "empty"}>{busy ? "Working…" : "Search"}</button>
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
            {showSemantic && (
              <p className="note">
                <button type="button" className="linkish" disabled={busy} onClick={() => void runAssistant()}>No, Alfred, not what I wanted. Ask Oracle instead</button>
              </p>
            )}
            {(live.hiddenWatched > 0 || watched.size > 0) && (
              <p className="note">
                {live.hiddenWatched > 0 && `${live.hiddenWatched} hidden because you marked them watched. `}
                {watched.size > 0 && <button type="button" className="linkish" onClick={clear}>Clear watched list ({watched.size})</button>}
              </p>
            )}
          </div>

          <div className="panel">
            <h2>Parser trace</h2>
            <ul className="trace">
              {parsed.trace.length ? parsed.trace.map((t, i) => <li key={i}>{t}</li>) : <li>Nothing parsed yet.</li>}
            </ul>
          </div>
        </div>
      </section>

      </div>
      {devMode && (
        <DevPanel
          live={{ parseMs, route: { ...route, kind: decision.route }, reason: decision.reason, hints: chipsToSearchHints(chips) }}
          entries={dev.entries}
        />
      )}
      </div>

      <footer className="foot">
        <p><img src={tmdbLogo} alt="TMDB" height={10} /> This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <p>Search text and assistant questions are sent to Cloudflare Workers AI. Your watched list stays in this browser.</p>
      </footer>
    </main>
  );
}

type CatalogState = { status: "loading" } | { status: "missing" } | { status: "ready"; meta: CatalogMeta; catalog: Movie[]; config: ParserConfig };

const DEV_MODE_KEY = "alfred.devMode";
function readDevMode(): boolean {
  try {
    return localStorage.getItem(DEV_MODE_KEY) === "on";
  } catch {
    return false;
  }
}

/** Loads the seeded catalog, then shows the search. */
export function MoviesPage() {
  const [state, setState] = useState<CatalogState>({ status: "loading" });
  const dev = useDevLog();
  const [loadEntry, setLoadEntry] = useState<number | null>(null);
  const [devMode, setDevMode] = useState(readDevMode);
  const toggleDev = () =>
    setDevMode((on) => {
      try {
        localStorage.setItem(DEV_MODE_KEY, on ? "off" : "on");
      } catch {
        // Storage blocked: the toggle still works for this visit.
      }
      return !on;
    });
  // React's StrictMode runs effects twice in development; load (and log) the catalog once.
  const loadStarted = useRef(false);
  useEffect(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    const entry = dev.start("load", "Page load");
    setLoadEntry(entry);
    const report = (file: string, bytes: number, ms: number) => dev.add(entry, { stage: "data", label: file, detail: `${(bytes / 1e6).toFixed(2)} MB`, ms });
    loadCatalog(report)
      .then(({ meta, catalog }) => {
        const started = performance.now();
        const config = buildMovieParserConfig(catalog);
        dev.add(entry, { stage: "rules", label: "Parser dictionaries built", detail: `${catalog.length.toLocaleString()} movies`, ms: Math.round(performance.now() - started) });
        setState({ status: "ready", meta, catalog, config });
      })
      .catch(() => setState({ status: "missing" }));
  }, [dev.start, dev.add]);

  if (state.status === "ready") {
    return <MovieSearch meta={state.meta} catalog={state.catalog} config={state.config} dev={dev} loadEntry={loadEntry} devMode={devMode} onToggleDev={toggleDev} />;
  }
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
