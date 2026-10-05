import { hydrateCatalog, type CatalogMeta, type Movie } from "./catalog";
import { createStoryLoader, type StoryShard } from "./stories";
import { createVectorIndex, type VectorIndex } from "./vectors";

/** Browser loaders for the static files in public/data (written by scripts/seed.ts). */

const url = (path: string) => `${import.meta.env.BASE_URL}${path}`;

async function fetchOk(path: string): Promise<Response> {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}

export async function loadCatalog(): Promise<{ meta: CatalogMeta; catalog: Movie[] }> {
  const meta = (await (await fetchOk("data/catalog-meta.json")).json()) as CatalogMeta;
  return { meta, catalog: hydrateCatalog(meta) };
}

/** About 3.8 MB at 10k movies. Load after the page appears. */
export async function loadVectors(meta: CatalogMeta): Promise<VectorIndex> {
  if (!meta.vectors) throw new Error("The catalog has no search vectors. Run the seed without --dry-run.");
  const bytes = await (await fetchOk(`data/${meta.vectors.file}`)).arrayBuffer();
  return createVectorIndex(meta.movies.map((m) => m.id), new Int8Array(bytes), meta.movies.map((m) => m.votes ?? 0));
}

export async function loadSynopses(): Promise<Record<string, string>> {
  return (await (await fetchOk("data/catalog-synopses.json")).json()) as Record<string, string>;
}

export const loadStories = createStoryLoader(async (path) => (await (await fetchOk(path)).json()) as StoryShard);
