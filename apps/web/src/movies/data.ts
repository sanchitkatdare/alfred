import { hydrateCatalog, type CatalogMeta, type Movie } from "./catalog";
import { createStoryLoader, type StoryShard } from "./stories";
import { createVectorIndex, type VectorIndex } from "./vectors";

/** Browser loaders for the static files in public/data (written by scripts/seed.ts). */

const url = (path: string) => `${import.meta.env.BASE_URL}${path}`;

/** Called with the file name, decoded size in bytes, and time from request to parsed data. */
export type LoadReport = (file: string, bytes: number, ms: number) => void;
/** Called as a file downloads, with the decoded bytes read so far. */
export type ByteProgress = (bytes: number) => void;

async function fetchOk(path: string): Promise<Response> {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}

/** Reads the whole body, reporting decoded bytes as they arrive. */
async function readBytes(res: Response, onBytes?: ByteProgress): Promise<Uint8Array> {
  if (!onBytes || !res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
    onBytes(length);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function loadJson<T>(path: string, report?: LoadReport, onBytes?: ByteProgress): Promise<T> {
  const started = performance.now();
  const bytes = await readBytes(await fetchOk(path), onBytes);
  const value = JSON.parse(new TextDecoder().decode(bytes)) as T;
  report?.(path.split("/").pop()!, bytes.length, Math.round(performance.now() - started));
  return value;
}

export async function loadCatalog(report?: LoadReport, onBytes?: ByteProgress): Promise<{ meta: CatalogMeta; catalog: Movie[] }> {
  const meta = await loadJson<CatalogMeta>("data/catalog-meta.json", report, onBytes);
  return { meta, catalog: hydrateCatalog(meta) };
}

/** Size of the vector file: one byte per dimension per movie. */
export const vectorBytes = (meta: CatalogMeta) => (meta.vectors ? meta.movies.length * meta.vectors.dimensions : 0);

/** About 7.7 MB at 20k movies. */
export async function loadVectors(meta: CatalogMeta, report?: LoadReport, onBytes?: ByteProgress): Promise<VectorIndex> {
  if (!meta.vectors) throw new Error("The catalog has no search vectors. Run the seed without --dry-run.");
  const started = performance.now();
  const bytes = await readBytes(await fetchOk(`data/${meta.vectors.file}`), onBytes);
  const index = createVectorIndex(meta.movies.map((m) => m.id), new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), meta.movies.map((m) => m.votes ?? 0));
  report?.(meta.vectors.file, bytes.byteLength, Math.round(performance.now() - started));
  return index;
}

export function loadSynopses(report?: LoadReport, onBytes?: ByteProgress): Promise<Record<string, string>> {
  return loadJson("data/catalog-synopses.json", report, onBytes);
}

export const loadStories = createStoryLoader(async (path) => (await (await fetchOk(path)).json()) as StoryShard);
