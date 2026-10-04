/**
 * Runs the movie assistant on fixed tasks with several Workers AI models and reports
 * pass rate, latency, neurons and tool-argument errors. Calls models directly, not through
 * AI Gateway, so its rate limit and cache do not affect the numbers.
 *
 *   node scripts/compare-models.ts [model ...]
 */
import { readFile, writeFile } from "node:fs/promises";
import { createAgent, createToolRegistry, type AgentEvent, type LLMProvider } from "@alfred/agent-harness";
import { getPlatformProxy } from "wrangler";
import { movieSystemPrompt, runMovieChat } from "../server/chat.ts";
import { getMovieStories } from "../server/details.ts";
import type { Env } from "../server/env.ts";
import { searchMovies } from "../server/search.ts";
import { hydrateCatalog, type CatalogMeta, type Movie } from "../src/movies/catalog.ts";
import { createMovieTools } from "../src/movies/tools.ts";

const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : [
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

const TASKS: Task[] = [
  { id: "comedy-short", prompt: "Find me a comedy under 2 hours.", tool: "search_movies", args: (a) => a.genres?.includes("comedy") && a.maxRuntime > 0 && a.maxRuntime <= 120 },
  { id: "like-not", prompt: "Something like Inception but not sci-fi.", tool: "search_movies", args: (a) => a.excludeGenres?.includes("sci-fi") },
  { id: "scene", prompt: "What's the movie where a guy tattoos clues on his body because he can't remember anything?", tool: "search_movies", answer: /memento/i },
  { id: "story", prompt: "What is Memento about?", tool: "get_movie_details", answer: /memor|remember/i },
  { id: "group", prompt: "Pick a movie for me and a friend who hates horror. Rated above 7 please.", tool: "search_movies", args: (a) => a.excludeGenres?.includes("horror") && a.minRating >= 7 },
  { id: "mark", prompt: "I just watched The Dark Knight. Mark it as watched.", tool: "mark_watched", check: (w, id) => w.has(id("The Dark Knight")) },
  { id: "unseen", prompt: "Which Christopher Nolan films haven't I seen yet?", watched: ["Inception", "Interstellar"], tool: "search_movies", args: (a) => (a.people ?? []).some((p: string) => /nolan/i.test(p)), answerNot: /inception|interstellar/i },
];

interface TaskResult { model: string; task: string; pass: boolean; why: string; ms: number; neurons: number; llmCalls: number; validationErrors: number; answer: string }

const meta = JSON.parse(await readFile("public/data/catalog-meta.json", "utf8")) as CatalogMeta;
const catalog: Movie[] = hydrateCatalog(meta);
const byTitle = (t: string) => catalog.find((m) => m.title === t)?.id ?? -1;

const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
const env = proxy.env;
const results: TaskResult[] = [];

for (const model of MODELS) {
  for (const task of TASKS) {
    const watched = new Set((task.watched ?? []).map(byTitle));
    const tools = createToolRegistry(createMovieTools({
      catalog,
      getWatched: () => watched,
      markWatched: (id) => watched.add(id),
      search: async (text, ids) => (await searchMovies(env, { text, ids, limit: 50 })).body.results,
      details: (ids) => getMovieStories(env, ids),
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
    else if (task.args && !matching.some((c) => { try { return task.args!(c.arguments as Args); } catch { return false; } })) fails.push(`args ${JSON.stringify(matching[0]!.arguments)}`);
    if (task.answer && !task.answer.test(answer)) fails.push("answer missing expected text");
    if (task.answerNot?.test(answer)) fails.push("answer lists a watched movie");
    if (task.check && !task.check(watched, byTitle)) fails.push("state check failed");

    const r: TaskResult = { model, task: task.id, pass: !fails.length, why: fails.join("; "), ms, neurons: Math.round(neurons * 10) / 10, llmCalls, validationErrors, answer };
    results.push(r);
    console.log(`${r.pass ? "PASS" : "FAIL"} ${model.split("/").pop()!.padEnd(24)} ${task.id.padEnd(13)} ${String(ms).padStart(6)} ms ${String(r.neurons).padStart(6)} neurons ${llmCalls} calls ${r.why}`);
  }
}

console.log("\nModel                      pass   avg time   avg neurons   validation errors");
for (const model of MODELS) {
  const rs = results.filter((r) => r.model === model);
  const avg = (f: (r: TaskResult) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  console.log(`${model.split("/").pop()!.padEnd(26)} ${rs.filter((r) => r.pass).length}/${rs.length}   ${(avg((r) => r.ms) / 1000).toFixed(1).padStart(6)} s   ${avg((r) => r.neurons).toFixed(1).padStart(8)}      ${rs.reduce((s, r) => s + r.validationErrors, 0)}`);
}
const total = results.reduce((s, r) => s + r.neurons, 0);
console.log(`\nTotal neurons used: ${total.toFixed(0)}`);
await writeFile(process.env.COMPARE_OUT ?? "compare-results.json", JSON.stringify(results, null, 2));
await proxy.dispose();
process.exit(0);
