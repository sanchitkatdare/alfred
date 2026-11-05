import { decideRoute, parse, type Chip, type ParserConfig } from "@alfred/agent-harness";
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import tmdbLogo from "../../../../assets/tmdb.svg";
import { createEmbedClient } from "./api";
import { DevPanel } from "./DevPanel";
import { short, useDevLog, type DevLog } from "./devlog";
import { AssistantPanel } from "./AssistantPanel";
import { createMovieAssistant } from "./assistant";
import type { CatalogMeta, Movie } from "./catalog";
import { buildMovieParserConfig, MOVIE_ROUTER_OPTIONS } from "./config";
import { loadCatalog, loadStories, loadSynopses, loadVectors, vectorBytes } from "./data";
import { aboutAnswer, answerFromCatalog, buildTitleIndex, describeLookup, detectLookup, RUNS_ON_ENTER, type Lookup } from "./lookups";
import { chipsToSearchHints } from "./hints";
import { byRating, filterCatalog } from "./tools";
import { useWatched } from "./useWatched";
import { wordSegments } from "./highlight";
import { pipelineStages } from "./pipeline";
import { ResultsPanel } from "./ResultsPanel";
import { decideAppRoute, startsNewSearch, type AppRoute } from "./routing";
import { useAssistantConversation } from "./useAssistantConversation";
import { searchKey, useSemanticSearch } from "./useSemanticSearch";
import { rankByVector, type VectorIndex } from "./vectors";

const MAX_QUERY_CHARS = 300;

const EXAMPLES = [
  "a jennifer lawrence action movie",
  "movie with deNiro and pacino",
  "like inception but not sci-fi, under 2 hours",
  "mind-bending villeneuve film",
  "the one where a man tattoos clues on his body",
  "movie above 7 that does not have horror",
];

const KIND_LABEL: Record<string, string> = {
  genre: "genre", actor: "actor", director: "director", runtime: "runtime", year: "year",
  rating: "rating", similar: "like", task: "task", user: "my data",
};

const ROUTES: Record<AppRoute, { name: string; cost: string; detail: string }> = {
  lookup: { name: "Lookup", cost: "0 AI calls", detail: "Answered by code from the catalog, the story files or your watched list. No LLM." },
  local: { name: "Local filter", cost: "0 AI calls · no network", detail: "The list below updates as you type; Search changes nothing." },
  semantic: { name: "Search by meaning", cost: "1 embedding · 0 LLM · ≈ 0.1 s", detail: "Press Enter: the server turns the free text into a vector, and your browser ranks the filtered movies by meaning." },
  assistant: { name: "Assistant", cost: "2-5 LLM calls · ≈ 5-10 s", detail: "Press Enter: the assistant searches, reads and decides in up to 5 steps. You see each step." },
  empty: { name: "Waiting for input", cost: "", detail: "Type a request or pick an example." },
};

type LoadFile = "meta" | "synopses" | "vectors";

/** Share of the catalog files downloaded, 0 to 1. Null until the metadata has loaded (sizes unknown). */
function loadProgress(loaded: Record<LoadFile, number>, meta: CatalogMeta): number | null {
  const synopses = meta.synopses?.bytes ?? 0;
  const total = loaded.meta + synopses + vectorBytes(meta);
  const done = loaded.meta + (synopses ? loaded.synopses : 0) + loaded.vectors;
  return total ? Math.min(1, done / total) : null;
}

const loadingLabel = (progress: number | null) => `Loading movies…${progress === null ? "" : ` ${Math.floor(progress * 100)}%`}`;

/** Thin bar along the bottom of the search input; animated stripe while the total size is unknown. */
function LoadBar({ progress }: { progress: number | null }) {
  return (
    <span className={`loadbar${progress === null ? " indeterminate" : ""}`} role="progressbar" aria-label="Loading movies" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress === null ? undefined : Math.floor(progress * 100)}>
      <span style={progress === null ? undefined : { width: `${progress * 100}%` }} />
    </span>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <p><img src={tmdbLogo} alt="TMDB" height={10} /> This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      <p>Search text and assistant questions are sent to Cloudflare Workers AI. Your watched list stays in this browser.</p>
    </footer>
  );
}

interface MovieSearchProps {
  meta: CatalogMeta;
  catalog: Movie[];
  config: ParserConfig;
  dev: DevLog;
  loadEntry: number | null;
  devMode: boolean;
  onToggleDev(): void;
  /** Download progress of the catalog files, for the search bar. */
  progress: number | null;
  onBytes(file: LoadFile, bytes: number): void;
}

const loadItem = (file: string, bytes: number, ms: number) => ({ stage: "data" as const, label: file, detail: `${(bytes / 1e6).toFixed(2)} MB`, ms });

function MovieSearch({ meta, catalog, config, dev, loadEntry, devMode, onToggleDev, progress, onBytes }: MovieSearchProps) {
  const [query, setQuery] = useState("");
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const { watched, getWatched, markWatched, unmark, clear } = useWatched();
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const seenSigs = useRef<Set<string>>(new Set());
  const byId = useMemo(() => new Map(catalog.map((m) => [m.id, m])), [catalog]);
  const titleIndex = useMemo(() => buildTitleIndex(catalog), [catalog]);

  // Vectors and synopses load right after the metadata; the search bar stays disabled until both have arrived.
  const vectorsRef = useRef<Promise<VectorIndex> | null>(null);
  const reportLoad = useCallback(
    (file: string, bytes: number, ms: number) => dev.add(loadEntry, loadItem(file, bytes, ms)),
    [dev.add, loadEntry],
  );
  const getVectors = useCallback(() => {
    if (!vectorsRef.current) {
      const p = loadVectors(meta, reportLoad, (n) => onBytes("vectors", n));
      vectorsRef.current = p;
      p.catch(() => vectorsRef.current === p && (vectorsRef.current = null));
    }
    return vectorsRef.current;
  }, [meta, reportLoad, onBytes]);
  const [synopses, setSynopses] = useState<Record<string, string>>({});
  // A failed file still ends the wait: filters work without it, and search by meaning shows its own error.
  const [dataReady, setDataReady] = useState(false);
  useEffect(() => {
    // The timer lets React's StrictMode drop its first, discarded effect run before anything downloads.
    const t = setTimeout(() => {
      void Promise.allSettled([getVectors(), loadSynopses(reportLoad, (n) => onBytes("synopses", n)).then(setSynopses)]).then(() => {
        setDataReady(true);
        if (loadEntry !== null) dev.finish(loadEntry);
      });
    }, 0);
    return () => clearTimeout(t);
  }, [getVectors, reportLoad, onBytes, dev.finish, loadEntry]);

  // iOS Safari keeps the layout viewport when the keyboard opens; --kb lifts the pinned composer above the keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => document.documentElement.style.setProperty("--kb", `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // The dev-log entry that background reports (embedding, tool searches) belong to.
  const currentEntry = useRef<number | null>(null);

  const embed = useMemo(
    () => createEmbedClient(undefined, (r) => dev.add(currentEntry.current, { stage: "search", label: r.cached ? "Query vector from browser cache" : "Query vector from server", detail: `"${short(r.text, 60)}"${r.neurons !== undefined ? " · neurons estimated from tokens" : ""}`, ms: r.ms, neurons: r.neurons, serverCall: !r.cached })),
    [dev.add],
  );
  const search = useCallback(async (text: string, ids: number[]) => rankByVector(await getVectors(), await embed(text), ids), [embed, getVectors]);
  const ask = useMemo(
    () =>
      createMovieAssistant({
        catalog, getWatched, search, details: loadStories,
        onSearch: (r) =>
          dev.add(currentEntry.current, {
            stage: "search",
            label: "search_movies filters",
            detail: `model: ${short(r.modelArgs, 120)} → applied after hints: ${short(r.appliedArgs, 120)} · ${r.matches} matches, ${r.returned} returned`,
            ms: r.ms,
          }),
      }),
    [catalog, getWatched, search, dev.add],
  );

  const { turns, running, runAssistant, stop, resetConversation } = useAssistantConversation(ask, dev, currentEntry);
  const { parsed, parseMs } = useMemo(() => {
    const started = performance.now();
    const result = parse(query, config);
    return { parsed: result, parseMs: performance.now() - started };
  }, [query, config]);
  const chips = parsed.chips.filter((c) => !removed.has(c.sig));
  const ruleDecision = decideRoute({ chips, leftover: parsed.leftover }, MOVIE_ROUTER_OPTIONS);
  // Lookups and actions on our own data come first and never use the LLM.
  const [ignoreLookup, setIgnoreLookup] = useState(false);
  const detected = useMemo(() => detectLookup(query, titleIndex), [query, titleIndex]);
  const lookup = ignoreLookup ? null : detected;
  const [ignoreFollowUp, setIgnoreFollowUp] = useState(false);
  const decision = decideAppRoute({ query, lookup, rules: ruleDecision, inConversation: turns.some((t) => t.status === "done"), ignoreFollowUp });
  const followUp = decision.followUp;
  const deferredChips = useDeferredValue(chips);
  const live = useMemo(() => {
    // Same filter as the assistant's search_movies: chips become hard filters.
    const all = filterCatalog(catalog, { ...chipsToSearchHints(deferredChips), includeWatched: true }, watched).sort(byRating);
    const movies = all.filter((m) => !watched.has(m.id));
    return { movies, hiddenWatched: all.length - movies.length };
  }, [catalog, deferredChips, watched]);

  const fresh = new Set(chips.filter((c) => !seenSigs.current.has(c.sig)).map((c) => c.sig));
  seenSigs.current = new Set(chips.map((c) => c.sig));

  const { semantic, searching, searchError, setSearchError, runSearch } = useSemanticSearch({ catalog, byId, watched, dev, currentEntry, embed, getVectors });
  const logRules = (id: number) => {
    dev.add(id, { stage: "rules", label: `Route: ${decision.route}`, detail: `${decision.reason} · parsed in ${parseMs.toFixed(2)} ms` });
    const hints = chipsToSearchHints(chips);
    if (Object.keys(hints).length) dev.add(id, { stage: "rules", label: "Hard filters from chips", detail: short(hints, 160) });
  };
  // Lookups (Level 2 workflows): answered by code. Read-only ones show while typing; the rest run on Enter.
  const [lookupResult, setLookupResult] = useState<{ query: string; text: string } | null>(null);
  const watchedListText = () => {
    const titles = [...watched].map((id) => byId.get(id)).filter((m): m is Movie => !!m).reverse().map((m) => `${m.title} (${m.year})`);
    return titles.length ? `You have marked ${titles.length} movie${titles.length === 1 ? "" : "s"} as watched${titles.length > 20 ? " (latest 20)" : ""}:\n${titles.slice(0, 20).join("\n")}` : "You have not marked any movies as watched in this browser.";
  };
  const liveLookupText = lookup && !RUNS_ON_ENTER.has(lookup.kind) ? (lookup.kind === "watched-list" ? watchedListText() : answerFromCatalog(lookup)) : null;
  const runLookup = async (l: Lookup) => {
    const entry = dev.start("lookup", query);
    logRules(entry);
    const started = performance.now();
    const m = l.movie;
    if (l.kind === "about" && m) setLookupResult({ query, text: aboutAnswer(m, (await loadStories([m.id]))[0]) });
    dev.add(entry, { stage: "rules", label: "Answered by code", detail: `${l.kind}${l.kind === "about" ? " · 1 story file" : ""} · no LLM`, ms: Math.round(performance.now() - started) });
    dev.finish(entry);
  };
  const lookupText = liveLookupText ? { text: liveLookupText } : lookupResult?.query === query ? lookupResult : null;

  const setText = (text: string) => {
    setQuery(text.slice(0, MAX_QUERY_CHARS));
    setRemoved(new Set());
    setSearchError(null);
    setIgnoreFollowUp(false);
    setIgnoreLookup(false);
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
  const askAssistant = (tier?: "oracle") => runAssistant(query, chipsToSearchHints(chips), logRules, tier);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    // Touch screens: close the keyboard so the answer has room.
    if (matchMedia("(pointer: coarse)").matches) inputRef.current?.blur();
    if (startsNewSearch(query, ignoreFollowUp)) {
      resetConversation();
      window.scrollTo({ top: 0 });
    }
    if (decision.route === "lookup" && lookup) void runLookup(lookup);
    else if (decision.route === "assistant") void askAssistant();
    else if (decision.route === "semantic") void runSearch({ query, chips, text: parsed.leftover.join(" ") }, logRules);
  };

  const route = ROUTES[decision.route];
  const showSemantic = semantic?.key === searchKey(query, chips);
  // After the assistant answers this text, the list shows the movies its answer names.
  const lastTurn = turns.at(-1);
  const picks = lastTurn?.status === "done" && lastTurn.picks?.length && lastTurn.question === query.trim() ? lastTurn.picks : null;
  const shown = picks
    ? picks.map((id) => byId.get(id)).filter((m): m is Movie => !!m && !watched.has(m.id))
    : showSemantic ? semantic!.movies.filter((m) => !watched.has(m.id)) : live.movies.slice(0, 10);
  // Results show once the query has a chip or filter, or after a search by meaning; free text alone is not a filter.
  const showResults = !!query.trim() && (chips.length > 0 || !!lookup || !!followUp || showSemantic || !!picks);
  // The layout follows what is on screen: nothing to show centers the composer (home), anything else pins it to the bottom.
  const home = !showResults && !searchError && !turns.length && !running && !lookup;
  const [layoutHome, setLayoutHome] = useState(home);
  useEffect(() => {
    if (home === layoutHome) return;
    // Animate the change: the browser morphs the title and the search form between their two places.
    const doc = document as Document & { startViewTransition?(update: () => void): unknown };
    if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(() => flushSync(() => setLayoutHome(home)));
    else setLayoutHome(home);
  }, [home, layoutHome]);

  return (
    <main className={`page${devMode ? " with-dev" : ""}`}>
      <header className="head">
        <div className="head-row">
          <button type="button" className="btn ghost dev-toggle" aria-pressed={devMode} onClick={onToggleDev}>
            Dev mode: {devMode ? "on" : "off"}
          </button>
        </div>
      </header>

      <div className="layout">
      <div className="main-col">
      <section className={`sim${layoutHome ? " home" : ""}`} aria-label="Movie search">
        {/* The title stays in the search column in both layouts, so it moves only up and down. */}
        {!layoutHome && <h1 className="page-title">Alfred, Movies!</h1>}
        <div className="composer">
        <div className="above">
        {layoutHome && <h1 className="home-title">Alfred, Movies!</h1>}
        {/* One slot above the input in both states: examples while the input is empty, chips once it has text. */}
        {query.trim() ? (
        <div className="understood">
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
            {lookup && (
              <span className="chip lookup">
                <span className="kind">lookup</span><span className="val">{describeLookup(lookup)}</span>
                <button type="button" className="x" aria-label="Remove lookup" onClick={() => setIgnoreLookup(true)}>×</button>
              </span>
            )}
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
          </div>
        </div>
        ) : (
          <div className="examples">
            <span className="eyebrow">Examples</span>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="ex" disabled={!dataReady} onClick={() => setText(ex)}>{ex}</button>
            ))}
          </div>
        )}
        </div>
        <form className="qbox" onSubmit={onSubmit}>
          <label htmlFor="q">Ask for a movie</label>
          <div className="qrow">
            <div className="qinput">
              <div ref={mirrorRef} className="qmirror" aria-hidden="true">
                {wordSegments(query, parsed).map((seg, i) => {
                  const chip = seg.sig ? chips.find((c) => c.sig === seg.sig) : undefined;
                  return <span key={i} className={chip && devMode ? `mark ${chip.negate ? "neg" : chip.kind}` : undefined}>{seg.text}</span>;
                })}
              </div>
              <input id="q" ref={inputRef} type="text" disabled={!dataReady} placeholder={dataReady ? "Ask for a movie" : loadingLabel(progress)} autoComplete="off" spellCheck={false} maxLength={MAX_QUERY_CHARS} value={query} onChange={(e) => setText(e.target.value)} onScroll={(e) => { if (mirrorRef.current) mirrorRef.current.scrollLeft = e.currentTarget.scrollLeft; }} />
              {query && <button type="button" className="clear" aria-label="Clear search" onClick={() => { setText(""); inputRef.current?.focus(); }}>×</button>}
              {!dataReady && <LoadBar progress={progress} />}
            </div>
            <button type="submit" className="btn" disabled={!dataReady || busy || decision.route === "empty"}>{busy ? "Working…" : "Search"}</button>
          </div>
          {devMode && (
            <ol className="pipeline" aria-label="Stages used">
              {pipelineStages(dev.entries.find((e) => e.kind !== "load" && e.title.trim() === query.trim()) ?? null, parseMs).map((stage) => (
                <li key={stage.id} className={`stage-${stage.id}${stage.ran ? " ran" : ""}`} tabIndex={0} aria-describedby={`stage-pop-${stage.id}`}>
                  <span>{stage.label}</span>
                  <span className="pipeline-ms">{stage.ran ? stage.time : "not used"}</span>
                  <span className="stage-pop" id={`stage-pop-${stage.id}`} role="tooltip">
                    <span className="flow">{stage.flow.map((step, i) => <Fragment key={i}>{i > 0 && <span className="arrow" aria-label="then">→</span>}<span className="step">{step}</span></Fragment>)}</span>
                    <span className="note">{stage.note}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {query.length >= MAX_QUERY_CHARS - 50 && <span className="note counter">{query.length}/{MAX_QUERY_CHARS} characters</span>}
        </form>
        </div>

        {!layoutHome && <>
        {lookup && lookupText && (
          <section className="lookup-answer" aria-live="polite">
            <p>{lookupText.text}</p>
            {lookup.others.length > 0 && <p className="note">Also in the catalog: {lookup.others.map((m) => `${m.title} (${m.year})`).join(", ")}. Add the year to pick one.</p>}
          </section>
        )}
        {lookup && !lookupText && <p className="note">Press Enter to show the story. No AI involved.</p>}

        {(showResults || searchError) && <div className="grid">
          <ResultsPanel
            semantic={showSemantic && !picks ? semantic : null}
            picksBy={picks ? (lastTurn!.tier === "oracle" ? "Oracle" : "Alfred") : undefined}
            matchCount={live.movies.length}
            catalogSize={catalog.length}
            movies={shown}
            synopses={synopses}
            busy={busy}
            searchError={searchError}
            hiddenWatched={live.hiddenWatched}
            watchedMovies={[...watched].reverse().map((id) => byId.get(id)).filter((m): m is Movie => !!m)}
            onOracle={() => void askAssistant("oracle")}
            onDismissError={() => setSearchError(null)}
            onMark={markWatched}
            onUnmark={unmark}
            onClear={clear}
          />
        </div>}

        {/* The conversation sits below the list, next to the input it answers. */}
        <AssistantPanel turns={turns} running={running} devMode={devMode} onStop={stop} onReset={resetConversation} />
        </>}
      </section>

      </div>
      {devMode && (
        <DevPanel
          live={{ parseMs, route: { ...route, kind: decision.route }, reason: decision.reason, hints: chipsToSearchHints(chips), trace: parsed.trace }}
          entries={dev.entries}
        />
      )}
      </div>

      <Footer />
    </main>
  );
}

/** The home screen while the metadata downloads: same layout as MovieSearch, search bar disabled. */
function LoadingSearch({ devMode, onToggleDev }: { devMode: boolean; onToggleDev(): void }) {
  return (
    <main className={`page${devMode ? " with-dev" : ""}`}>
      <header className="head">
        <div className="head-row">
          <button type="button" className="btn ghost dev-toggle" aria-pressed={devMode} onClick={onToggleDev}>Dev mode: {devMode ? "on" : "off"}</button>
        </div>
      </header>
      <div className="layout">
        <div className="main-col">
          <section className="sim home" aria-label="Movie search" aria-busy="true">
            <div className="composer">
              <div className="above">
                <h1 className="home-title">Alfred, Movies!</h1>
                <div className="examples">
                  <span className="eyebrow">Examples</span>
                  {EXAMPLES.map((ex) => <button key={ex} type="button" className="ex" disabled>{ex}</button>)}
                </div>
              </div>
              <div className="qbox">
                <div className="qrow">
                  <div className="qinput">
                    <input id="q" type="text" disabled placeholder={loadingLabel(null)} />
                    <LoadBar progress={null} />
                  </div>
                  <button type="button" className="btn" disabled>Search</button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
      <Footer />
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
  // Bytes downloaded per catalog file. Chunks arrive often; the state updates at most once per frame.
  const [loaded, setLoaded] = useState<Record<LoadFile, number>>({ meta: 0, synopses: 0, vectors: 0 });
  const pendingBytes = useRef(loaded);
  const frame = useRef(0);
  const onBytes = useCallback((file: LoadFile, bytes: number) => {
    pendingBytes.current = { ...pendingBytes.current, [file]: bytes };
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setLoaded(pendingBytes.current);
    });
  }, []);
  // React's StrictMode runs effects twice in development; load (and log) the catalog once.
  const loadStarted = useRef(false);
  useEffect(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    const entry = dev.start("load", "Page load");
    setLoadEntry(entry);
    const report = (file: string, bytes: number, ms: number) => dev.add(entry, loadItem(file, bytes, ms));
    loadCatalog(report, (n) => onBytes("meta", n))
      .then(({ meta, catalog }) => {
        setLoaded(pendingBytes.current);
        const started = performance.now();
        const config = buildMovieParserConfig(catalog);
        dev.add(entry, { stage: "rules", label: "Parser dictionaries built", detail: `${catalog.length.toLocaleString()} movies`, ms: Math.round(performance.now() - started) });
        setState({ status: "ready", meta, catalog, config });
      })
      .catch(() => setState({ status: "missing" }));
  }, [dev.start, dev.add, onBytes]);

  if (state.status === "ready") {
    return <MovieSearch meta={state.meta} catalog={state.catalog} config={state.config} dev={dev} loadEntry={loadEntry} devMode={devMode} onToggleDev={toggleDev} progress={loadProgress(loaded, state.meta)} onBytes={onBytes} />;
  }
  if (state.status === "loading") return <LoadingSearch devMode={devMode} onToggleDev={toggleDev} />;
  return (
    <main className="page">
      <header className="head">
        <h1>Alfred Movies</h1>
        <p className="muted">The movie catalog is missing. Run <code>pnpm --filter @alfred/web seed --count 500</code> with <code>TMDB_TOKEN</code> in the repo-root <code>.env</code>.</p>
      </header>
    </main>
  );
}
