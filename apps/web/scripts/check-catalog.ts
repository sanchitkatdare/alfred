/**
 * Checks the seeded catalog against our limits and quality bars. Run after every seed.
 *
 *   pnpm check-catalog
 *
 * Reports file sizes, parser start-up and per-keystroke time, surname/title collisions,
 * browser ranking time, and search quality on known scene queries (about 1 neuron).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { parse, toKey } from "@alfred/agent-harness";
import { getPlatformProxy } from "wrangler";
import { embedQuery } from "../server/embed.ts";
import type { Env } from "../server/env.ts";
import { hydrateCatalog, type CatalogMeta } from "../src/movies/catalog.ts";
import { buildMovieParserConfig } from "../src/movies/config.ts";
import { createVectorIndex, rankByVector, VECTOR_FILE_BUDGET_BYTES } from "../src/movies/vectors.ts";

const DATA = "public/data";
const SCENES: [string, string][] = [
  ["guy tattoos clues on his body because he cannot remember", "Memento"],
  ["thieves enter dreams to plant an idea", "Inception"],
  ["robot left alone cleaning up a garbage-covered earth", "WALL·E"],
  ["a huge ship hits an iceberg", "Titanic"],
  ["hacker learns reality is a computer simulation", "The Matrix"],
  ["clownfish father crosses the ocean to find his son", "Finding Nemo"],
  ["cloned dinosaurs escape in an island theme park", "Jurassic Park"],
  ["insomniac starts an underground fight club", "Fight Club"],
  ["a man relives the same day over and over", "Groundhog Day"],
  ["boxer from philadelphia gets a shot at the heavyweight title", "Rocky"],
  ["shark terrorizes a beach town", "Jaws"],
  ["toys come alive when people leave the room", "Toy Story"],
  ["a girl travels to a magical land after a tornado", "The Wizard of Oz"],
  ["banker wrongly imprisoned escapes through a tunnel", "The Shawshank Redemption"],
  ["astronaut stranded on mars grows potatoes", "The Martian"],
];

const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.99)]!;

const meta = JSON.parse(await readFile(`${DATA}/catalog-meta.json`, "utf8")) as CatalogMeta;
const catalog = hydrateCatalog(meta);
console.log(`Catalog: ${catalog.length} movies, ${meta.people.length} people, generated ${meta.generatedAt}\n`);

// 1. File sizes
console.log("Files (raw / gzip):");
let browserGzip = 0;
for (const f of ["catalog-meta.json", "catalog-synopses.json", "catalog-vectors.bin"]) {
  const buf = await readFile(`${DATA}/${f}`);
  const gz = gzipSync(buf).length;
  browserGzip += gz;
  console.log(`  ${f.padEnd(24)} ${mb(buf.length).padStart(9)} / ${mb(gz)}`);
}
const storyFiles = await readdir(`${DATA}/stories`);
const storySizes = await Promise.all(storyFiles.map(async (f) => (await stat(`${DATA}/stories/${f}`)).size));
console.log(`  stories/ (${storyFiles.length} files)     ${mb(storySizes.reduce((a, b) => a + b, 0)).padStart(9)} total, largest ${(Math.max(...storySizes) / 1024).toFixed(0)} KB`);
const vectorBytes = (await stat(`${DATA}/catalog-vectors.bin`)).size;
console.log(`  Browser download after first paint: ${mb(browserGzip)} gzip. Vector file ${((vectorBytes / VECTOR_FILE_BUDGET_BYTES) * 100).toFixed(0)}% of its budget.\n`);

// 2. Parser
let t = performance.now();
const config = buildMovieParserConfig(catalog);
const buildMs = performance.now() - t;
const typed = ["a 90s crime movie without al pacino", "something like inception but not sci-fi under 2 hours", "plan a movie night for me and a friend who hates horror", "highly rated comedy with jennifer lawrence"];
const perKey: number[] = [];
for (const q of typed) for (let i = 1; i <= q.length; i++) {
  t = performance.now();
  parse(q.slice(0, i), config);
  perKey.push(performance.now() - t);
}
const surnames = [...config.dictionary.entries].filter(([, e]) => e.via === "surname").length;
const titleWords = new Set(catalog.flatMap((m) => m.title.split(/[^\p{L}\p{N}]+/u).map(toKey).filter((w) => w.length > 2)));
const collisions = [...config.dictionary.entries].filter(([k, e]) => e.via === "surname" && titleWords.has(k)).length;
console.log(`Parser: dictionary built in ${buildMs.toFixed(0)} ms, ${config.dictionary.entries.size} keys, ${surnames} surname-only keys, ${collisions} surname/title collisions.`);
console.log(`  Per keystroke: median ${median(perKey).toFixed(2)} ms, p99 ${p99(perKey).toFixed(2)} ms (${perKey.length} keystrokes).\n`);

// 3. Ranking and search quality
const index = createVectorIndex(meta.movies.map((m) => m.id), new Int8Array(await readFile(`${DATA}/catalog-vectors.bin`)), meta.movies.map((m) => m.votes ?? 0));
const titleOf = new Map(catalog.map((m) => [m.id, m.title]));
const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
const rankTimes: number[] = [];
let top1 = 0, top5 = 0, present = 0;
console.log("Scene queries (rank of the expected movie):");
for (const [q, expected] of SCENES) {
  if (!catalog.some((m) => m.title === expected)) {
    console.log(`  -      ${expected} is not in the catalog`);
    continue;
  }
  present++;
  const { vector } = (await embedQuery(proxy.env, q)).body;
  t = performance.now();
  const ranked = rankByVector(index, vector, undefined, 50);
  rankTimes.push(performance.now() - t);
  const pos = ranked.findIndex((r) => titleOf.get(r.id) === expected) + 1;
  top1 += +(pos === 1);
  top5 += +(pos >= 1 && pos <= 5);
  console.log(`  ${(pos ? `#${pos}` : ">50").padEnd(6)} ${expected.padEnd(26)} top: ${ranked.slice(0, 3).map((r) => titleOf.get(r.id)).join(" | ")}`);
}
await Promise.race([proxy.dispose(), new Promise((r) => setTimeout(r, 5000))]);
console.log(`\nSearch quality: ${top1}/${present} first, ${top5}/${present} in top 5.`);
console.log(`Ranking all ${catalog.length} vectors: median ${median(rankTimes).toFixed(1)} ms (Node; browsers are similar).`);
process.exit(0);
