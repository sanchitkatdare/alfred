/**
 * Builds the movie catalog from TMDB and seeds Vectorize.
 *
 *   pnpm seed --count 500            # files + vectors
 *   pnpm seed --count 500 --dry-run  # files only, no Workers AI or Vectorize calls
 *
 * Selection (docs/PLAN.md): about 85% by vote count, about 15% recent releases (last 2 years,
 * at least 100 votes) by popularity. Adult titles and runtimes under 60 minutes are excluded.
 *
 * Writes public/data/catalog-meta.json and public/data/catalog-synopses.json.
 * Needs TMDB_TOKEN (TMDB API Read Access Token) in the repo-root .env, and a Wrangler login
 * with ai:write, workers:write and workers_scripts:write.
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { getPlatformProxy } from "wrangler";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, type Env } from "../server/env.ts";
import type { CatalogMeta } from "../src/movies/catalog.ts";

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
const UPSERT_BATCH = 100;
const DETAIL_CONCURRENCY = 8;

const TMDB = "https://api.themoviedb.org/3";

interface DiscoverPage { results: { id: number }[]; total_pages: number }
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
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 && attempt <= 5) {
      await sleep(1000 * Number(res.headers.get("retry-after") ?? attempt));
      continue;
    }
    throw new Error(`TMDB ${path} failed: ${res.status} ${await res.text()}`);
  }
}

async function discoverIds(token: string, count: number, params: Record<string, string | number>): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 1; ids.length < count && page <= 500; page++) {
    const data = await tmdb<DiscoverPage>(token, "/discover/movie", {
      include_adult: "false", include_video: "false", language: "en-US", "with_runtime.gte": 60, page, ...params,
    });
    ids.push(...data.results.map((r) => r.id));
    if (page >= data.total_pages) break;
  }
  return ids.slice(0, count);
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

function storyMetadata(d: MovieDetails): Record<string, string> {
  return { overview: d.overview, tagline: d.tagline, keywords: d.keywords.keywords.map((k) => k.name).join(", ") };
}

const chunk = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

async function main() {
  const t0 = performance.now();
  const lap = (label: string) => console.log(`  ${label} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  {
    const token = process.env.TMDB_TOKEN;
    if (!token) throw new Error("TMDB_TOKEN is missing. Add it to the repo-root .env file.");

    console.log(`Selecting ${COUNT} movies from TMDB`);
    const recentCount = Math.round(COUNT * RECENT_SHARE);
    const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const [popular, recent] = await Promise.all([
      discoverIds(token, COUNT, { sort_by: "vote_count.desc" }),
      discoverIds(token, recentCount, { sort_by: "popularity.desc", "primary_release_date.gte": twoYearsAgo, "vote_count.gte": 100 }),
    ]);
    const ids = [...new Set([...recent, ...popular])].slice(0, COUNT);
    lap(`${ids.length} IDs (${recent.length} recent, ${popular.length} by vote count, deduplicated)`);

    const details = (await mapPool(ids, DETAIL_CONCURRENCY, (id) => tmdb<MovieDetails>(token, `/movie/${id}`, { append_to_response: "credits,keywords", language: "en-US" })))
      .filter((d) => d.release_date && (d.runtime ?? 0) >= 60);
    lap(`${details.length} movies with details`);

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
      year: Number(d.release_date.slice(0, 4)),
      runtime: d.runtime!,
      genres: d.genres.map((g) => genreId(g.name)),
      rating: Math.round(d.vote_average * 10) / 10,
      votes: d.vote_count,
      language: d.original_language,
      cast: [...d.credits.cast].sort((a, b) => a.order - b.order).slice(0, TOP_CAST).map((c) => ref(c.name)),
      directors: [...new Set(d.credits.crew.filter((c) => c.job === "Director").map((c) => c.name))].map(ref),
    }));
    const meta: CatalogMeta = { generatedAt: new Date().toISOString(), source: "TMDB", people, movies };
    const synopses = Object.fromEntries(details.map((d) => [d.id, synopsis(d.overview)]));
    const metaJson = JSON.stringify(meta);
    const synopsesJson = JSON.stringify(synopses);
    await writeFile("public/data/catalog-meta.json", metaJson);
    await writeFile("public/data/catalog-synopses.json", synopsesJson);
    lap(`Wrote catalog-meta.json (${(metaJson.length / 1024).toFixed(0)} KB) and catalog-synopses.json (${(synopsesJson.length / 1024).toFixed(0)} KB)`);

    const languages = Object.entries(movies.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.language ?? "?"]: (acc[m.language ?? "?"] ?? 0) + 1 }), {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, n]) => `${l} ${((n / movies.length) * 100).toFixed(0)}%`);
    console.log(`  Languages: ${languages.join(", ")}`);

    if (DRY_RUN) {
      console.log("Dry run: skipped embeddings and Vectorize.");
      return;
    }

    // Workers AI and Vectorize are reached through Wrangler's remote bindings (your Wrangler login).
    const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
    const env = proxy.env;
    try {
      const texts = details.map(embeddingText);
      const approxTokens = Math.round(texts.join(" ").length / 4);
      const vectors: number[][] = [];
      for (const batch of chunk(texts, EMBED_BATCH)) {
        const out = (await env.AI.run(EMBEDDING_MODEL, { text: batch })) as { data: number[][] };
        vectors.push(...out.data);
      }
      if (vectors[0]?.length !== EMBEDDING_DIMENSIONS) throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${vectors[0]?.length}`);
      lap(`Embedded ${vectors.length} texts, about ${approxTokens} tokens, about ${Math.ceil((approxTokens / 1e6) * 1841)} neurons (estimate)`);

      // Story text for the assistant's get_movie_details tool. Vectorize allows 10 KiB of metadata per vector.
      const records = details.map((d, i) => ({ id: String(d.id), values: vectors[i]!, metadata: storyMetadata(d) }));
      for (const batch of chunk(records, UPSERT_BATCH)) await env.VECTORIZE_MOVIES.upsert(batch);
      lap(`Upserted ${records.length} vectors into alfred-movies-v1`);
    } finally {
      await proxy.dispose();
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
