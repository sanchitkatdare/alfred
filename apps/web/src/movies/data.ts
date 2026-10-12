import { hydrateCatalog, type CatalogMeta, type Movie } from "./catalog";
import { createStoryLoader, type StoryShard } from "./stories";
import { createVectorIndex, type VectorIndex } from "./vectors";

/** Browser loaders for the static files in public/data (written by scripts/seed.ts). */

const url = (path: string) => `${import.meta.env.BASE_URL}${path}`;

/** Called with the file name, decoded size in bytes, and time from request to parsed data. */
export type LoadReport = (file: string, bytes: number, ms: number) => void;

async function fetchOk(path: string): Promise<Response> {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}

async function loadJson<T>(path: string, report?: LoadReport): Promise<T> {
  const started = performance.now();
  const text = await (await fetchOk(path)).text();
  const value = JSON.parse(text) as T;
  report?.(path.split("/").pop()!, text.length, Math.round(performance.now() - started));
  return value;
}

export async function loadCatalog(report?: LoadReport): Promise<{ meta: CatalogMeta; catalog: Movie[] }> {
  const meta = await loadJson<CatalogMeta>("data/catalog-meta.json", report);
  return { meta, catalog: hydrateCatalog(meta) };
}

/** About 3.8 MB at 10k movies. Load after the page appears. */
export async function loadVectors(meta: CatalogMeta, report?: LoadReport): Promise<VectorIndex> {
  if (!meta.vectors) throw new Error("The catalog has no search vectors. Run the seed without --dry-run.");
  const started = performance.now();
  const bytes = await (await fetchOk(`data/${meta.vectors.file}`)).arrayBuffer();
  const index = createVectorIndex(meta.movies.map((m) => m.id), new Int8Array(bytes), meta.movies.map((m) => m.votes ?? 0));
  report?.(meta.vectors.file, bytes.byteLength, Math.round(performance.now() - started));
  return index;
}

export function loadSynopses(report?: LoadReport): Promise<Record<string, string>> {
  return loadJson("data/catalog-synopses.json", report);
}

export const loadStories = createStoryLoader(async (path) => (await (await fetchOk(path)).json()) as StoryShard);
