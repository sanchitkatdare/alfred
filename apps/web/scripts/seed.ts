/**
 * Builds the movie catalog from TMDB as static files for the browser.
 *
 *   pnpm seed --count 500            # all files, including search vectors
 *   pnpm seed --count 500 --dry-run  # all files except vectors; no Workers AI calls
 *
 * Selection (docs/PLAN.md, Catalog): three language shares. English 60%, Indian languages 15% (split by each
 * language's count at 10+ votes), rest of the world 25%. Within each share about 15% are recent releases (last
 * 2 years) by popularity, the rest by vote count. Adult titles and runtimes under 60 minutes are excluded, and
 * every movie must pass the quality gate (English overview, runtime, release date, cast).
 *
 * Writes to public/data/:
 *   catalog-meta.json              movie metadata; names the matching vector file (written last)
 *   catalog-synopses.json          short synopses for result lists
 *   catalog-vectors.<hash>.bin     8-bit search vectors, in catalog-meta.json order (see src/movies/vectors.ts).
 *                                  The hash in the name keeps metadata and vectors in step when browsers cache old files.
 *   stories/<n>.json       overview, tagline and keywords for get_movie_details (see src/movies/stories.ts)
 *
 * Embeddings are cached in .cache/embeddings.json by text hash, so a re-run embeds only new or changed movies.
 * Needs TMDB_TOKEN (TMDB API Read Access Token) in the repo-root .env, and a Wrangler login
 * with ai:write, workers:write and workers_scripts:write.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { getPlatformProxy } from "wrangler";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, type Env } from "../server/env.ts";
import type { CatalogMeta } from "../src/movies/catalog.ts";
import { STORY_SHARDS, storyShardOf, type StoryShard } from "../src/movies/stories.ts";
import { quantize, VECTOR_DIMENSIONS, VECTOR_FILE_BUDGET_BYTES } from "../src/movies/vectors.ts";

const { values: args } = parseArgs({
  options: { count: { type: "string", default: "500" }, "dry-run": { type: "boolean", default: false } },
});
const COUNT = Number(args.count);
const DRY_RUN = args["dry-run"];
const RECENT_SHARE = 0.15;
const PAGE_SIZE = 20;
const SYNOPSIS_CHARS = 160;
const TOP_CAST = 4;
const EMBED_BATCH = 50;
const CACHE_FILE = ".cache/embeddings.json";
const DETAIL_CONCURRENCY = 8;
const MIN_OVERVIEW_CHARS = 150;
const INDIAN_LANGUAGES = ["hi", "ta", "te", "ml", "kn", "bn", "mr", "pa", "gu"];
/** Language shares of the catalog. `minVotes` is the TMDB vote floor for candidates in that share. */
const SHARES = { english: { share: 0.6, minVotes: 100 }, indian: { share: 0.15, minVotes: 5 }, world: { share: 0.25, minVotes: 100 } };
/** Indian slots are split by each language's count of movies with at least this many votes. */
const INDIAN_WEIGHT_VOTES = 10;

const TMDB = "https://api.themoviedb.org/3";
const TMDB_TIMEOUT_MS = 15_000;
/** TMDB discover serves at most 500 pages per query. */
const MAX_PAGES = 500;

interface Candidate { id: number; votes: number; popularity: number; date: string }
interface DiscoverPage { results: { id: number; vote_count: number; popularity: number; release_date?: string }[]; total_pages: number }
interface MovieDetails {
  id: number;
  title: string;
  original_title: string;
  original_language: string;
  release_date: string;
  runtime: number | null;
  overview: string;
  tagline: string;
  keywords: { keywords: { name: string }[] };
  vote_average: number;
  vote_count: number;
  genres: { id: number; name: string }[];
  credits: { cast: { name: string; order: number }[]; crew: { name: string; job: string }[] };
}

const GENRE_IDS: Record<string, string> = { "science fiction": "sci-fi", "tv movie": "tv-movie" };
const genreId = (name: string) => GENRE_IDS[name.toLowerCase()] ?? name.toLowerCase();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tmdb<T>(token: string, path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(TMDB + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      // A stalled connection would otherwise hang the seed forever.
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) });
    } catch (e) {
      if (attempt <= 5) {
        console.log(`  TMDB ${path}: ${e instanceof Error ? e.message : e}. Retrying (${attempt}/5).`);
        await sleep(1000 * attempt);
        continue;
      }
      throw e;
    }
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
      await sleep(1000 * Number(res.headers.get("retry-after") ?? attempt));
      continue;
    }
    throw new Error(`TMDB ${path} failed: ${res.status} ${await res.text()}`);
  }
}

/** Every movie in one original language with at least `minVotes` votes, most votes first. Continues past the 500-page limit. */
async function discoverLanguage(token: string, language: string, minVotes: number): Promise<Candidate[]> {
  const found = new Map<number, Candidate>();
  let maxVotes: number | undefined;
  for (;;) {
    let page = 1;
    let total = 1;
    for (; page <= Math.min(total, MAX_PAGES); page++) {
      const data = await tmdb<DiscoverPage>(token, "/discover/movie", {
        include_adult: "false", include_video: "false", language: "en-US", "with_runtime.gte": 60, sort_by: "vote_count.desc",
        with_original_language: language, "vote_count.gte": minVotes, ...(maxVotes !== undefined ? { "vote_count.lte": maxVotes } : {}), page,
      });
      total = data.total_pages;
      for (const r of data.results) found.set(r.id, { id: r.id, votes: r.vote_count, popularity: r.popularity, date: r.release_date ?? "" });
    }
    if (total <= MAX_PAGES) break;
    // Page limit reached: query again from the lowest vote count seen.
    const lowest = Math.min(...[...found.values()].map((c) => c.votes));
    if (lowest === maxVotes) break;
    maxVotes = lowest;
  }
  return [...found.values()];
}

/** Recent releases by popularity first (up to the recent share), then the rest by vote count. */
function ordered(candidates: Candidate[], slots: number, recentSince: string): Candidate[] {
  const recent = candidates.filter((c) => c.date >= recentSince).sort((a, b) => b.popularity - a.popularity).slice(0, Math.round(slots * RECENT_SHARE));
  const taken = new Set(recent.map((c) => c.id));
  return [...recent, ...candidates.filter((c) => !taken.has(c.id)).sort((a, b) => b.votes - a.votes)];
}

const passesGate = (d: MovieDetails) =>
  !!d.release_date && (d.runtime ?? 0) >= 60 && d.overview.trim().length >= MIN_OVERVIEW_CHARS && d.credits.cast.length > 0;

/** Fetches details in list order until `slots` movies pass the quality gate. Returns them and the untried rest of the list. */
async function fill(token: string, list: Candidate[], slots: number): Promise<{ kept: MovieDetails[]; rest: Candidate[] }> {
  const kept: MovieDetails[] = [];
  let next = 0;
  while (kept.length < slots && next < list.length) {
    const batch = list.slice(next, next + Math.ceil((slots - kept.length) * 1.2) + 5);
    next += batch.length;
    const details = await mapPool(batch, DETAIL_CONCURRENCY, (c) =>
      tmdb<MovieDetails>(token, `/movie/${c.id}`, { append_to_response: "credits,keywords", language: "en-US" }).catch(() => null),
    );
    for (const d of details) if (d && passesGate(d) && kept.length < slots) kept.push(d);
  }
  return { kept, rest: list.slice(next) };
}

/** Splits `total` slots in proportion to `weights`, largest remainders first. */
function split(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < total - out.reduce((a, b) => a + b, 0); k++) out[order[k]![1]]!++;
  return out;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

function synopsis(text: string): string {
  if (text.length <= SYNOPSIS_CHARS) return text;
  const cut = text.slice(0, SYNOPSIS_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.\s]+$/, "")}…`;
}

/** Text behind each search vector. Keywords carry story elements that overviews leave out ("tattoo", "time loop"). */
function embeddingText(d: MovieDetails): string {
  const keywords = d.keywords.keywords.map((k) => k.name).join(", ");
  return [`${d.title}.`, d.tagline, `${d.genres.map((g) => g.name).join(", ")}.`, d.overview, keywords && `Keywords: ${keywords}.`]
    .filter(Boolean)
    .join(" ");
}

function story(d: MovieDetails): StoryShard[string] {
  return { overview: d.overview, tagline: d.tagline, keywords: d.keywords.keywords.map((k) => k.name).join(", ") };
}

/** Embedding cache: id -> hash of model and text, plus the float vector as base64. */
type EmbeddingCache = Record<string, { hash: string; vector: string }>;
const textHash = (text: string) => createHash("sha256").update(`${EMBEDDING_MODEL}\n${text}`).digest("hex").slice(0, 16);
const encodeVector = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString("base64");
const decodeVector = (s: string) => Array.from(new Float32Array(Uint8Array.from(Buffer.from(s, "base64")).buffer));

/** Retries a remote call: Wrangler's remote connection can drop during long runs. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts) throw e;
      console.log(`  Retrying after error (${attempt}/${attempts - 1}): ${e instanceof Error ? e.message : e}`);
      await sleep(2000 * attempt);
    }
  }
}

async function readCache(): Promise<EmbeddingCache> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8")) as EmbeddingCache;
  } catch {
    return {};
  }
}

const chunk = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

async function main() {
  const t0 = performance.now();
  const lap = (label: string) => console.log(`  ${label} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  {
    const token = process.env.TMDB_TOKEN;
    if (!token) throw new Error("TMDB_TOKEN is missing. Add it to the repo-root .env file.");

    console.log(`Selecting ${COUNT} movies from TMDB`);
    const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const englishSlots = Math.round(COUNT * SHARES.english.share);
    const indianSlots = Math.round(COUNT * SHARES.indian.share);
    const worldSlots = COUNT - englishSlots - indianSlots;

    const worldLanguages = (await tmdb<{ iso_639_1: string }[]>(token, "/configuration/languages"))
      .map((l) => l.iso_639_1)
      .filter((code) => code !== "en" && code !== "xx" && !INDIAN_LANGUAGES.includes(code));
    const [english, indianByLanguage, worldByLanguage] = await Promise.all([
      discoverLanguage(token, "en", SHARES.english.minVotes),
      mapPool(INDIAN_LANGUAGES, 3, (code) => discoverLanguage(token, code, SHARES.indian.minVotes)),
      mapPool(worldLanguages, 4, (code) => discoverLanguage(token, code, SHARES.world.minVotes)),
    ]);
    const world = worldByLanguage.flat();
    lap(`Candidates: ${english.length} English, ${indianByLanguage.flat().length} Indian, ${world.length} rest of the world`);

    const englishPick = await fill(token, ordered(english, englishSlots, twoYearsAgo), englishSlots);
    lap(`English: ${englishPick.kept.length}/${englishSlots}`);

    const indianQuotas = split(indianSlots, indianByLanguage.map((cands) => cands.filter((c) => c.votes >= INDIAN_WEIGHT_VOTES).length));
    const indianPicks = await mapPool(INDIAN_LANGUAGES.map((_, i) => i), 3, (i) =>
      fill(token, ordered(indianByLanguage[i]!, indianQuotas[i]!, twoYearsAgo), indianQuotas[i]!),
    );
    // A language that runs short passes its slots to the other Indian languages, by vote count.
    const indianShort = indianSlots - indianPicks.reduce((n, p) => n + p.kept.length, 0);
    const indianExtra = indianShort > 0 ? await fill(token, indianPicks.flatMap((p) => p.rest).sort((a, b) => b.votes - a.votes), indianShort) : { kept: [] };
    const indian = [...indianPicks.flatMap((p) => p.kept), ...indianExtra.kept];
    lap(`Indian: ${indian.length}/${indianSlots} (${INDIAN_LANGUAGES.map((code, i) => `${code} ${indianPicks[i]!.kept.length}/${indianQuotas[i]}`).join(", ")}, ${indianExtra.kept.length} reassigned)`);

    const worldPick = await fill(token, ordered(world, worldSlots, twoYearsAgo), worldSlots);
    lap(`Rest of the world: ${worldPick.kept.length}/${worldSlots}`);

    const details = [...englishPick.kept, ...indian, ...worldPick.kept];
    lap(`${details.length} movies passed the quality gate`);

    const people: string[] = [];
    const personIndex = new Map<string, number>();
    const ref = (name: string) => {
      if (!personIndex.has(name)) personIndex.set(name, people.push(name) - 1);
      return personIndex.get(name)!;
    };
    const movies: CatalogMeta["movies"] = details.map((d) => ({
      id: d.id,
      title: d.title,
      ...(d.original_title !== d.title ? { originalTitle: d.original_title } : {}),
      language: d.original_language,
      year: Number(d.release_date.slice(0, 4)),
      runtime: d.runtime!,
      genres: d.genres.map((g) => genreId(g.name)),
      rating: Math.round(d.vote_average * 10) / 10,
      votes: d.vote_count,
      cast: [...d.credits.cast].sort((a, b) => a.order - b.order).slice(0, TOP_CAST).map((c) => ref(c.name)),
      directors: [...new Set(d.credits.crew.filter((c) => c.job === "Director").map((c) => c.name))].map(ref),
    }));
    const synopses = Object.fromEntries(details.map((d) => [d.id, synopsis(d.overview)]));
    const synopsesJson = JSON.stringify(synopses);
    const meta: CatalogMeta = { generatedAt: new Date().toISOString(), source: "TMDB", people, movies, synopses: { bytes: Buffer.byteLength(synopsesJson) } };
    await writeFile("public/data/catalog-synopses.json", synopsesJson);
    lap(`Wrote catalog-synopses.json (${(synopsesJson.length / 1024).toFixed(0)} KB)`);
    const writeMeta = async () => {
      const metaJson = JSON.stringify(meta);
      await writeFile("public/data/catalog-meta.json", metaJson);
      lap(`Wrote catalog-meta.json (${(metaJson.length / 1024).toFixed(0)} KB)${meta.vectors ? `, vectors: ${meta.vectors.file}` : ", no vectors"}`);
    };


    await rm("public/data/stories", { recursive: true, force: true });
    await mkdir("public/data/stories", { recursive: true });
    const shards: StoryShard[] = Array.from({ length: STORY_SHARDS }, () => ({}));
    for (const d of details) shards[storyShardOf(d.id)]![d.id] = story(d);
    await Promise.all(shards.map((shard, n) => writeFile(`public/data/stories/${n}.json`, JSON.stringify(shard))));
    lap(`Wrote ${STORY_SHARDS} story files`);

    if (DRY_RUN) {
      await writeMeta();
      console.log("Dry run: skipped embeddings and the vector file. Search needs a full run.");
      return;
    }

    const cache = await readCache();
    const texts = details.map(embeddingText);
    const hashes = texts.map(textHash);
    const missing = details.map((d, i) => i).filter((i) => cache[details[i]!.id]?.hash !== hashes[i]);
    if (missing.length) {
      // Workers AI is reached through Wrangler's remote binding (your Wrangler login).
      const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
      try {
        await mkdir(".cache", { recursive: true });
        const batches = chunk(missing, EMBED_BATCH);
        for (const [n, batch] of batches.entries()) {
          const out = await withRetry(() => proxy.env.AI.run(EMBEDDING_MODEL, { text: batch.map((i) => texts[i]!) }) as Promise<{ data: number[][] }>);
          if (out.data[0]?.length !== EMBEDDING_DIMENSIONS) throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${out.data[0]?.length}`);
          batch.forEach((i, k) => (cache[details[i]!.id] = { hash: hashes[i]!, vector: encodeVector(out.data[k]!) }));
          // Save after every batch, so an interrupted run loses at most one batch of paid embeddings.
          await writeFile(CACHE_FILE, JSON.stringify(cache));
          if ((n + 1) % 20 === 0 || n === batches.length - 1) lap(`Embedded batch ${n + 1}/${batches.length}`);
        }
      } finally {
        await proxy.dispose();
      }
    }
    const kept: EmbeddingCache = Object.fromEntries(details.map((d) => [d.id, cache[d.id]!]));
    await mkdir(".cache", { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(kept));
    const approxTokens = Math.round(missing.map((i) => texts[i]!).join(" ").length / 4);
    lap(`Embeddings: ${details.length - missing.length} reused from cache, ${missing.length} new (about ${approxTokens} tokens, about ${Math.ceil((approxTokens / 1e6) * 1841)} neurons, estimate)`);

    const rows = new Int8Array(details.length * VECTOR_DIMENSIONS);
    details.forEach((d, r) => rows.set(quantize(decodeVector(kept[d.id]!.vector)), r * VECTOR_DIMENSIONS));
    if (rows.byteLength > VECTOR_FILE_BUDGET_BYTES) {
      throw new Error(`The vector file would be ${rows.byteLength} bytes, over the ${VECTOR_FILE_BUDGET_BYTES}-byte budget. Lower --count.`);
    }
    const vectorFile = `catalog-vectors.${createHash("sha256").update(rows).digest("hex").slice(0, 12)}.bin`;
    for (const old of (await readdir("public/data")).filter((f) => /^catalog-vectors(\..+)?\.bin$/.test(f))) await rm(`public/data/${old}`);
    await writeFile(`public/data/${vectorFile}`, rows);
    lap(`Wrote ${vectorFile} (${(rows.byteLength / 1e6).toFixed(2)} MB of ${(VECTOR_FILE_BUDGET_BYTES / 1e6).toFixed(1)} MB budget)`);
    meta.vectors = { file: vectorFile, dimensions: VECTOR_DIMENSIONS };
    await writeMeta();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
