import { useState } from "react";
import { QUESTION_LIMIT_MS } from "./assistant";
import type { Movie } from "./catalog";
import type { SemanticResult } from "./useSemanticSearch";

/** Stacked bar: meaning plus popularity bonus, scaled to the top result. */
function ScoreBar({ score, max }: { score: { similarity: number; bonus: number }; max: number }) {
  const percent = (n: number) => `${(Math.max(0, n) / max) * 100}%`;
  return (
    <span className="score" role="img" aria-label={`Meaning ${score.similarity.toFixed(2)}, popularity bonus ${score.bonus.toFixed(2)}`} title={`Meaning ${score.similarity.toFixed(2)} + popularity ${score.bonus.toFixed(2)}`}>
      <span className="score-meaning" style={{ width: percent(score.similarity) }} />
      <span className="score-bonus" style={{ width: percent(score.bonus) }} />
    </span>
  );
}

const formatRuntime = (min: number) => `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;

interface ResultsPanelProps {
  /** Results of search by meaning for the current query; null shows the live filter results. */
  semantic: SemanticResult | null;
  /** Set when the list shows the movies the assistant's answer names. */
  picksBy?: "Alfred" | "Oracle";
  matchCount: number;
  catalogSize: number;
  movies: Movie[];
  synopses: Record<string, string>;
  busy: boolean;
  searchError: string | null;
  hiddenWatched: number;
  watchedMovies: Movie[];
  onOracle(): void;
  onDismissError(): void;
  onMark(id: number): void;
  onUnmark(id: number): void;
  onClear(): void;
}

export function ResultsPanel({ semantic, picksBy, matchCount, catalogSize, movies, synopses, busy, searchError, hiddenWatched, watchedMovies, onOracle, onDismissError, onMark, onUnmark, onClear }: ResultsPanelProps) {
  // Accordion: only the clicked movie shows its details.
  const [openId, setOpenId] = useState<number | null>(null);
  const scores = semantic?.scores;
  const maxScore = Math.max(0.01, ...Object.values(scores ?? {}).map((s) => s.similarity + s.bonus));
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{picksBy ? `${picksBy}'s picks` : semantic ? "Best matches by meaning" : "Results"}</h2>
        {picksBy ? null : semantic ? <span className="note">ranked in {semantic.ms} ms</span> : matchCount < catalogSize && <span className="note">{matchCount} {matchCount === 1 ? "match" : "matches"}</span>}
      </div>
      {(semantic || picksBy === "Alfred") && (
        <button type="button" className="linkish oracle" disabled={busy} onClick={onOracle} title={`Sends your request to Gemma, Google's open model, on Cloudflare Workers AI. Slower: up to ${QUESTION_LIMIT_MS.oracle / 1000} s.`}>
          No, Alfred, not what I wanted. Ask Oracle instead
        </button>
      )}
      {searchError && (
        <p className="answer failed dismissible" role="alert">
          <span>{searchError}</span>
          <button type="button" className="x" aria-label="Dismiss error" onClick={onDismissError}>×</button>
        </p>
      )}
      <ul className="results">
        {movies.map((movie) => {
          const open = openId === movie.id;
          return (
            <li key={movie.id} className={open ? "open" : undefined}>
              <button type="button" className="row" aria-expanded={open} aria-controls={`movie-${movie.id}`} onClick={() => setOpenId(open ? null : movie.id)}>
                <span className="t">{movie.title}</span>
                {scores?.[movie.id] && <ScoreBar score={scores[movie.id]!} max={maxScore} />}
              </button>
              {open && (
                <div className="more" id={`movie-${movie.id}`}>
                  <span className="m">{movie.year} · {formatRuntime(movie.runtime)} · ★ {movie.rating.toFixed(1)} · {movie.genres.join(", ")}</span>
                  {synopses[movie.id] && <span className="syn">{synopses[movie.id]}</span>}
                  <button type="button" className="w" onClick={() => onMark(movie.id)}>Mark watched</button>
                </div>
              )}
            </li>
          );
        })}
        {!movies.length && <li><span className="empty">No movie matches these filters.</span></li>}
      </ul>
      {hiddenWatched > 0 && <p className="note">{hiddenWatched} hidden because you marked them watched.</p>}
      {watchedMovies.length > 0 && (
        <details className="watched">
          <summary>Watched ({watchedMovies.length})</summary>
          <ul>
            {watchedMovies.map((m) => (
              <li key={m.id}>
                <span>{m.title} ({m.year})</span>
                <button type="button" className="w" onClick={() => onUnmark(m.id)}>Remove</button>
              </li>
            ))}
          </ul>
          <button type="button" className="linkish" onClick={onClear}>Clear all</button>
        </details>
      )}
    </div>
  );
}
