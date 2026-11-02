import type { Chip } from "@alfred/agent-harness";
import { useState, type RefObject } from "react";
import { friendlyError } from "./api";
import type { Movie } from "./catalog";
import type { DevLog } from "./devlog";
import { chipsToSearchHints } from "./hints";
import { filterCatalog } from "./tools";
import { blend, rankByVector, scoreParts, vectorOf, type VectorIndex } from "./vectors";

export interface SemanticResult {
  /** The query and active filters these results belong to. */
  key: string;
  movies: Movie[];
  /** Meaning score and popularity bonus per movie id. */
  scores: Record<number, { similarity: number; bonus: number }>;
  ms: number;
}

interface Options {
  catalog: Movie[];
  byId: Map<number, Movie>;
  watched: ReadonlySet<number>;
  dev: DevLog;
  /** The dev-log entry that background reports belong to. */
  currentEntry: RefObject<number | null>;
  embed(text: string): Promise<number[]>;
  getVectors(): Promise<VectorIndex>;
}

/** Results stay valid only for the same text and the same chips. Removing a chip makes them stale. */
export const searchKey = (query: string, chips: Chip[]) => JSON.stringify([query, chips.map((c) => c.sig)]);

/** Search by meaning: the server turns free text into a vector, and the browser ranks the filtered movies. */
export function useSemanticSearch({ catalog, byId, watched, dev, currentEntry, embed, getVectors }: Options) {
  const [semantic, setSemantic] = useState<SemanticResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const runSearch = async ({ query, chips, text }: { query: string; chips: Chip[]; text: string }, logRules: (entry: number) => void) => {
    setSearching(true);
    setSearchError(null);
    const started = performance.now();
    const entry = dev.start("search", query);
    currentEntry.current = entry;
    logRules(entry);
    try {
      const similar = chips.find((c) => c.kind === "similar");
      const similarId = similar ? Number(similar.id) : null;
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
      setSemantic({ key: searchKey(query, chips), movies: ranked.map((r) => byId.get(r.id)!), scores: Object.fromEntries(ranked.map((r) => [r.id, scoreParts(index, r.id, r.score)])), ms: Math.round(performance.now() - started) });
    } catch (e) {
      setSearchError(friendlyError(e));
      dev.add(entry, { stage: "search", label: "Error", detail: friendlyError(e) });
    } finally {
      setSearching(false);
      dev.finish(entry);
      currentEntry.current = null;
    }
  };

  return { semantic, searching, searchError, setSearchError, runSearch };
}
