import type { Movie } from "./catalog";
import type { SemanticResult } from "./useSemanticSearch";

const formatRuntime = (min: number) => `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;

interface ResultsPanelProps {
  /** Results of search by meaning for the current query; null shows the live filter results. */
  semantic: SemanticResult | null;
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

export function ResultsPanel({ semantic, matchCount, catalogSize, movies, synopses, busy, searchError, hiddenWatched, watchedMovies, onOracle, onDismissError, onMark, onUnmark, onClear }: ResultsPanelProps) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{semantic ? "Best matches by meaning" : "Results"}</h2>
        <div className="panel-head-side">
          <span className="note">{semantic ? `ranked in ${semantic.ms} ms` : `${matchCount} of ${catalogSize} match`}</span>
          {semantic && <button type="button" className="linkish" disabled={busy} onClick={onOracle}>No, Alfred, not what I wanted. Ask Oracle instead</button>}
        </div>
      </div>
      {searchError && (
        <p className="answer failed dismissible" role="alert">
          <span>{searchError}</span>
          <button type="button" className="x" aria-label="Dismiss error" onClick={onDismissError}>×</button>
        </p>
      )}
      <ul className="results">
        {movies.map((movie) => (
          <li key={movie.id}>
            <span className="t">{movie.title}</span>
            <button type="button" className="w" onClick={() => onMark(movie.id)}>Mark watched</button>
            <span className="m">{movie.year} · {formatRuntime(movie.runtime)} · ★ {movie.rating.toFixed(1)} · {movie.genres.join(", ")}</span>
            {synopses[movie.id] && <span className="syn">{synopses[movie.id]}</span>}
          </li>
        ))}
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
