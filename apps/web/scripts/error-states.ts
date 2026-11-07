/**
 * Error states in a real browser. Each scenario fakes one failure (a dropped download, a server error,
 * an empty model reply, blocked storage) and checks what the visitor sees. The API is faked, so no AI calls.
 * Needs the page server (`pnpm --filter @alfred/web dev:vite`, or `pnpm dev`) and Google Chrome.
 *
 *   pnpm --filter @alfred/web error-states [--url http://localhost:5173]
 */
import { parseArgs } from "node:util";
import { chromium, type Page, type Route } from "playwright-core";

const { values: cli } = parseArgs({ options: { url: { type: "string", default: "http://localhost:5173" } } });

const SEMANTIC = "a heist that goes wrong";
const ASSISTANT = "suggest two heist movies with a twist and explain why";
const TIMEOUT = 15_000;

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const fakeVector = (route: Route) => json(route, 200, { vector: Array.from({ length: 384 }, (_, i) => Math.sin(i)) });
const reply = (content: string) => (route: Route) => json(route, 200, { message: { role: "assistant", content }, model: "fake" });
/** Fails the first `times` requests, then lets the rest through. */
const failFirst = (times: number, fail: (route: Route) => Promise<void>) => {
  let n = 0;
  return (route: Route) => (n++ < times ? fail(route) : route.continue());
};

async function ask(page: Page, text: string) {
  const q = page.locator("#q:not([disabled])");
  await q.waitFor({ timeout: TIMEOUT });
  await q.fill(text);
  await q.press("Enter");
}
const see = (page: Page, text: string | RegExp) => page.getByText(text).first().waitFor({ timeout: TIMEOUT });
async function notSee(page: Page, text: string | RegExp) {
  if (await page.getByText(text).count()) throw new Error(`unexpected text: ${text}`);
}

const scenarios: { name: string; setup?(page: Page): Promise<unknown>; check(page: Page): Promise<void> }[] = [
  {
    name: "catalog download fails: readable message, Try again loads the page",
    setup: (page) => page.route("**/data/catalog-meta.json", failFirst(1, (r) => r.abort("internetdisconnected"))),
    async check(page) {
      await see(page, "Could not load the movies. Check your connection and try again.");
      await notSee(page, /seed|TMDB_TOKEN/);
      await page.getByRole("button", { name: "Try again" }).click();
      await page.locator("#q:not([disabled])").waitFor({ timeout: TIMEOUT });
    },
  },
  {
    name: "catalog file missing (before a seed run): developer instructions",
    setup: (page) => page.route("**/data/catalog-meta.json", (r) => r.fulfill({ status: 404, body: "Not found" })),
    check: (page) => see(page, "The movie catalog is missing."),
  },
  {
    name: "synopses fail: the search bar still enables",
    setup: (page) => page.route("**/data/catalog-synopses.json", (r) => r.abort("failed")),
    check: (page) => page.locator("#q:not([disabled])").waitFor({ timeout: TIMEOUT }),
  },
  {
    name: "embedding server fails: search shows the server's message",
    setup: (page) => page.route("**/api/movies/embed", (r) => json(r, 502, { error: "Search is unavailable right now. Filters still work." })),
    async check(page) {
      await ask(page, SEMANTIC);
      await see(page, "Search is unavailable right now. Filters still work.");
    },
  },
  {
    name: "vector file fails: an error, then the next search loads it again",
    async setup(page) {
      await page.route("**/api/movies/embed", fakeVector);
      // The first request is the background load; the second is the first search's retry.
      await page.route("**/data/catalog-vectors.*", failFirst(2, (r) => r.abort("failed")));
    },
    async check(page) {
      await ask(page, SEMANTIC);
      await page.getByRole("alert").first().waitFor({ timeout: TIMEOUT });
      await ask(page, SEMANTIC);
      await page.getByRole("heading", { name: "Best matches by meaning" }).waitFor({ timeout: TIMEOUT });
    },
  },
  {
    name: "assistant returns an empty answer: failure with Ask Oracle",
    setup: (page) => page.route("**/api/movies/chat", reply("")),
    async check(page) {
      await ask(page, ASSISTANT);
      await see(page, "Alfred gave no answer. Try again, or ask Oracle.");
      await page.getByRole("button", { name: "Ask Oracle" }).waitFor({ timeout: TIMEOUT });
      await notSee(page, "(no answer)");
    },
  },
  {
    name: "assistant model too slow (504): timeout message with Ask Oracle",
    setup: (page) => page.route("**/api/movies/chat", (r) => json(r, 504, { error: "The model took too long." })),
    async check(page) {
      await ask(page, ASSISTANT);
      await see(page, /Alfred took too long\. Try again, or ask Oracle\./);
      await page.getByRole("button", { name: "Ask Oracle" }).waitFor({ timeout: TIMEOUT });
    },
  },
  {
    name: "assistant server fails (502): the server's message, no raw error",
    setup: (page) => page.route("**/api/movies/chat", (r) => json(r, 502, { error: "The assistant is unavailable right now. Search and filters still work." })),
    async check(page) {
      await ask(page, ASSISTANT);
      await see(page, "The assistant is unavailable right now. Search and filters still work.");
      await notSee(page, /LLM provider|HTTP 502/);
    },
  },
  {
    name: "user presses Stop: Stopped, without Ask Oracle",
    setup: (page) => page.route("**/api/movies/chat", () => {}), // never answers
    async check(page) {
      await ask(page, ASSISTANT);
      await page.getByRole("button", { name: "Stop" }).click({ timeout: TIMEOUT });
      await see(page, "Stopped.");
      await notSee(page, "Ask Oracle");
    },
  },
  {
    name: "storage blocked (private mode): the page works and Mark watched hides the movie",
    setup: (page) =>
      // A string, not a function: tsx rewrites functions with helpers that do not exist in the page.
      page.addInitScript(`Object.defineProperty(window, "localStorage", { get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });`),
    async check(page) {
      await ask(page, "korean thriller");
      const first = page.locator(".results .row").first();
      const title = (await first.locator(".t").innerText()).trim();
      await first.click();
      await page.getByRole("button", { name: "Mark watched" }).click();
      await see(page, "1 hidden because you marked them watched.");
      if ((await page.locator(".results .t").first().innerText()).trim() === title) throw new Error("the watched movie is still first");
    },
  },
];

const browser = await chromium.launch({ channel: "chrome" });
const failures: string[] = [];
try {
  for (const s of scenarios) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await s.setup?.(page);
      await page.goto(cli.url!);
      await s.check(page);
      if (errors.length) throw new Error(`uncaught page error: ${errors[0]}`);
      console.log(`pass  ${s.name}`);
    } catch (e) {
      failures.push(s.name);
      console.log(`FAIL  ${s.name}\n      ${(e as Error).message.split("\n")[0]}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} of ${scenarios.length} failed.` : `\nAll ${scenarios.length} error states pass.`);
process.exit(failures.length ? 1 : 0);
