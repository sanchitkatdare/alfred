/**
 * Runs the movie assistant on fixed tasks with several Workers AI models and reports
 * pass rate, latency, neurons and tool-argument errors. Calls models directly, not through
 * AI Gateway, so its rate limit and cache do not affect the numbers.
 *
 *   pnpm compare-models [--runs N] [--hints] [model ...]
 *
 * --hints: the rule parser reads each prompt and its filters are applied to every search (planned for the app).
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createAgent, createToolRegistry, parse, type AgentEvent, type LLMProvider } from "@alfred/agent-harness";
import { getPlatformProxy } from "wrangler";
import { movieSystemPrompt, runMovieChat } from "../server/chat.ts";
import { getMovieStories } from "../server/details.ts";
import type { Env } from "../server/env.ts";
import { searchMovies } from "../server/search.ts";
import { hydrateCatalog, type CatalogMeta, type Movie } from "../src/movies/catalog.ts";
import { buildMovieParserConfig } from "../src/movies/config.ts";
import { chipsToSearchHints, mergeSearchHints, type SearchHints } from "../src/movies/hints.ts";
import { createMovieTools } from "../src/movies/tools.ts";

const { values: cli, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: "string", default: "1" }, hints: { type: "boolean", default: false } } });
const HINTS = cli.hints;
const RUNS = Number(cli.runs);
const MODELS = positionals.length ? positionals : [
  "@cf/ibm-granite/granite-4.0-h-micro",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/google/gemma-4-26b-a4b-it",
];

type Args = Record<string, any>;
interface Task {
  id: string;
  prompt: string;
  watched?: string[];
  tool: string;
  args?: (a: Args) => boolean;
  answer?: RegExp;
  answerNot?: RegExp;
  check?: (watched: Set<number>, byTitle: (t: string) => number) => boolean;
}

const people = (a: Args) => (a.people ?? []).join(" ").toLowerCase();
const has = (list: unknown, v: string) => Array.isArray(list) && list.includes(v);

const TASKS: Task[] = [
  // Filters
  { id: "comedy-short", prompt: "Find me a comedy under 2 hours.", tool: "search_movies", args: (a) => has(a.genres, "comedy") && a.maxRuntime > 0 && a.maxRuntime <= 120 },
  { id: "90s-thriller", prompt: "A good 90s thriller.", tool: "search_movies", args: (a) => has(a.genres, "thriller") && a.yearFrom >= 1989 && a.yearFrom <= 1990 && a.yearTo >= 1999 && a.yearTo <= 2000 },
  { id: "long-epic", prompt: "A long epic over 2.5 hours, highly rated.", tool: "search_movies", args: (a) => a.minRuntime >= 150 && a.minRuntime <= 151 && a.minRating >= 7 },
  { id: "recent-horror", prompt: "A good horror movie from the last two years.", tool: "search_movies", args: (a) => has(a.genres, "horror") && a.yearFrom >= 2024 },
  { id: "mood", prompt: "I'm feeling down. I need something uplifting and funny.", tool: "search_movies", args: (a) => !!a.query || has(a.genres, "comedy") },
  // People
  { id: "actor-pair", prompt: "Movies with Leonardo DiCaprio and Tom Hardy together.", tool: "search_movies", args: (a) => people(a).includes("dicaprio") && people(a).includes("hardy"), answer: /inception|revenant/i },
  { id: "director-genre", prompt: "What's the best Denis Villeneuve sci-fi movie?", tool: "search_movies", args: (a) => people(a).includes("villeneuve") },
  { id: "actor-not-genre", prompt: "Something with Tom Hanks, but not animated.", tool: "search_movies", args: (a) => people(a).includes("hanks") && has(a.excludeGenres, "animation"), answerNot: /toy story/i },
  { id: "without-actor", prompt: "A crime movie without Al Pacino.", tool: "search_movies", args: (a) => has(a.genres, "crime") && (a.excludePeople ?? []).join(" ").toLowerCase().includes("pacino"), answerNot: /godfather|scarface/i },
  // Exclusions and groups
  { id: "like-not", prompt: "Something like Inception but not sci-fi.", tool: "search_movies", args: (a) => has(a.excludeGenres, "sci-fi") },
  { id: "group", prompt: "Pick a movie for me and a friend who hates horror. Rated above 7 please.", tool: "search_movies", args: (a) => has(a.excludeGenres, "horror") && a.minRating >= 7 },
  // Plot and scene recall
  { id: "scene-memento", prompt: "What's the movie where a guy tattoos clues on his body because he can't remember anything?", tool: "search_movies", answer: /memento/i },
  { id: "scene-titanic", prompt: "The film where a huge ship hits an iceberg and a poor artist falls for a rich girl.", tool: "search_movies", answer: /titanic/i },
  { id: "scene-matrix", prompt: "Which movie has a hacker who learns reality is a computer simulation?", tool: "search_movies", answer: /matrix/i },
  { id: "scene-nemo", prompt: "The animated one where a clownfish dad crosses the ocean to find his son.", tool: "search_movies", answer: /nemo/i },
  { id: "story", prompt: "What is Memento about?", tool: "get_movie_details", answer: /memor|remember/i },
  { id: "story-fightclub", prompt: "What's Fight Club about? No spoilers.", tool: "get_movie_details", answer: /insomnia|soap|therapy|club/i },
  { id: "compare", prompt: "Which is shorter, Titanic or Forrest Gump?", tool: "search_movies", answer: /forrest gump/i },
  // Watched list
  { id: "mark", prompt: "I just watched The Dark Knight. Mark it as watched.", tool: "mark_watched", check: (w, id) => w.has(id("The Dark Knight")) },
  { id: "unseen", prompt: "Which Christopher Nolan films haven't I seen yet?", watched: ["Inception", "Interstellar"], tool: "search_movies", args: (a) => people(a).includes("nolan"), answerNot: /inception|interstellar/i },
  // Honesty
  { id: "unknown-actor", prompt: "Recommend a movie starring Zzyzx Qwertyman.", tool: "search_movies", answer: /no |not find|couldn.t|could not|didn.t find|no movies|unable|not in/i },
];

interface TaskResult { model: string; run: number; task: string; pass: boolean; why: string; ms: number; neurons: number; llmCalls: number; validationErrors: number; answer: string }

const meta = JSON.parse(await readFile("public/data/catalog-meta.json", "utf8")) as CatalogMeta;
const catalog: Movie[] = hydrateCatalog(meta);
const byTitle = (t: string) => catalog.find((m) => m.title === t)?.id ?? -1;
const parserConfig = buildMovieParserConfig(catalog);

const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
const env = proxy.env;
const results: TaskResult[] = [];

for (let round = 1; round <= RUNS; round++) for (const model of MODELS) {
  for (const task of TASKS) {
    const watched = new Set((task.watched ?? []).map(byTitle));
    const hints: SearchHints = HINTS ? chipsToSearchHints(parse(task.prompt, parserConfig).chips) : {};
    const tools = createToolRegistry(createMovieTools({
      catalog,
      getWatched: () => watched,
      markWatched: (id) => watched.add(id),
      search: async (text, ids) => (await searchMovies(env, { text, ids, limit: 50 })).body.results,
      details: (ids) => getMovieStories(env, ids),
      getHints: () => hints,
    }));
    let neurons = 0;
    let llmCalls = 0;
    const provider: LLMProvider = {
      name: model,
      async complete({ messages }) {
        llmCalls++;
        const r = await runMovieChat(env, messages.filter((m) => m.role !== "system"), { model, gateway: false });
        neurons += r.usage?.neurons ?? 0;
        return r;
      },
    };
    const events: AgentEvent[] = [];
    const agent = createAgent({ provider, tools, system: movieSystemPrompt(), maxIterations: 5, retry: { maxValidationRetries: 2 }, onEvent: (e) => events.push(e) });

    const start = performance.now();
    const run = await agent.run(task.prompt);
    const ms = Math.round(performance.now() - start);
    const calls = events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
    const validationErrors = events.filter((e) => e.type === "validation_error").length;
    const answer = run.message?.content ?? "";

    const fails: string[] = [];
    if (run.status !== "done") fails.push(`status ${run.status}${run.error ? `: ${run.error}` : ""}`);
    const matching = calls.filter((c) => c.name === task.tool);
    if (!matching.length) fails.push(`no ${task.tool} call (called: ${calls.map((c) => c.name).join(", ") || "none"})`);
    else if (task.args && !matching.some((c) => {
      // With hints, check the arguments the search actually used.
      const used = c.arguments && typeof c.arguments === "object" && !(c.arguments as Args).title ? mergeSearchHints(c.arguments as Args, hints) : c.arguments;
      try { return task.args!(used as Args); } catch { return false; }
    })) fails.push(`args ${JSON.stringify(matching[0]!.arguments)}`);
    if (task.answer && !task.answer.test(answer)) fails.push("answer missing expected text");
    if (task.answerNot?.test(answer)) fails.push("answer lists a watched movie");
    if (task.check && !task.check(watched, byTitle)) fails.push("state check failed");

    const r: TaskResult = { model, run: round, task: task.id, pass: !fails.length, why: fails.join("; "), ms, neurons: Math.round(neurons * 10) / 10, llmCalls, validationErrors, answer };
    results.push(r);
    console.log(`${r.pass ? "PASS" : "FAIL"} ${model.split("/").pop()!.padEnd(24)} ${task.id.padEnd(13)} ${String(ms).padStart(6)} ms ${String(r.neurons).padStart(6)} neurons ${llmCalls} calls ${r.why}`);
  }
}

const short = (m: string) => m.split("/").pop()!;
const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;
console.log(`\n${TASKS.length} tasks x ${RUNS} run(s)${HINTS ? ", parser hints on" : ""}\nModel                      pass        avg time  p90 time  avg neurons  validation errors`);
for (const model of MODELS) {
  const rs = results.filter((r) => r.model === model);
  const avg = (f: (r: TaskResult) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  const passed = rs.filter((r) => r.pass).length;
  console.log(`${short(model).padEnd(26)} ${`${passed}/${rs.length}`.padEnd(6)} ${String(Math.round((passed / rs.length) * 100)).padStart(3)}%  ${(avg((r) => r.ms) / 1000).toFixed(1).padStart(6)} s  ${(pct(rs.map((r) => r.ms), 0.9) / 1000).toFixed(1).padStart(6)} s  ${avg((r) => r.neurons).toFixed(1).padStart(9)}  ${rs.reduce((s, r) => s + r.validationErrors, 0)}`);
}
console.log(`\nPasses per task (out of ${RUNS})\n${"task".padEnd(16)}${MODELS.map((m) => short(m).slice(0, 14).padEnd(16)).join("")}`);
for (const task of TASKS) {
  console.log(`${task.id.padEnd(16)}${MODELS.map((m) => String(results.filter((r) => r.model === m && r.task === task.id && r.pass).length).padEnd(16)).join("")}`);
}
const total = results.reduce((s, r) => s + r.neurons, 0);
console.log(`\nTotal neurons used: ${total.toFixed(0)}`);
await writeFile(process.env.COMPARE_OUT ?? "compare-results.json", JSON.stringify(results, null, 2));
await proxy.dispose();
process.exit(0);
