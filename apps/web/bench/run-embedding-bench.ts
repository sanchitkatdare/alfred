/**
 * Runs bench/embedding.html in Chrome and reports what a browser-side embedding model costs:
 * bytes transferred, time to ready, time per query, memory, and how closely its vectors match Workers AI.
 *
 *   pnpm bench:embedding            # desktop and mid-range phone profiles
 *
 * Uses the installed Google Chrome (no browser download). The phone profile is a simulation:
 * CPU slowed 4x, network 9 Mbit/s down, 1.5 Mbit/s up, 85 ms latency.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { getPlatformProxy } from "wrangler";
import { EMBEDDING_MODEL, type Env } from "../server/env.ts";

interface Profile { name: string; cpu: number; network?: { down: number; up: number; latency: number } }
const PROFILES: Profile[] = [
  { name: "desktop", cpu: 1 },
  { name: "mid-range phone (simulated)", cpu: 4, network: { down: (9 * 1e6) / 8, up: (1.5 * 1e6) / 8, latency: 85 } },
];
const MATCH_TEXTS = ["mind-bending dream heist", "a clownfish father crosses the ocean", "Inception. A thief enters dreams to plant an idea.", "feel-good family comedy", "war drama on a beach landing"];

const html = await readFile(join(import.meta.dirname, "embedding.html"));
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html)).listen(0);
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

/** Resident memory of Chrome's process tree, in MB. Chrome is identified by its Playwright profile folder. */
function chromeMemoryMb(): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).trim().split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: +m[1]!, ppid: +m[2]!, rss: +m[3]!, cmd: m[4]! }));
  const roots = rows.filter((r) => r.cmd.includes("playwright_chromiumdev_profile") && !r.cmd.includes("--type=")).map((r) => r.pid);
  const tree = new Set(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (tree.has(r.ppid) && !tree.has(r.pid)) { tree.add(r.pid); grew = true; }
  }
  return Math.round(rows.filter((r) => tree.has(r.pid)).reduce((s, r) => s + r.rss, 0) / 1024);
}

async function trackBytes(cdp: CDPSession) {
  const hosts = new Map<string, string>();
  const bytes = new Map<string, number>();
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => hosts.set(e.requestId, new URL(e.request.url).host));
  cdp.on("Network.loadingFinished", (e) => {
    const h = hosts.get(e.requestId) ?? "?";
    bytes.set(h, (bytes.get(h) ?? 0) + e.encodedDataLength);
  });
  return () => Object.fromEntries([...bytes].map(([h, b]) => [h, +(b / 1e6).toFixed(1)]));
}

async function visit(context: BrowserContext, profile: Profile) {
  const page: Page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const bytes = await trackBytes(cdp);
  if (profile.network) await cdp.send("Network.emulateNetworkConditions", { offline: false, downloadThroughput: profile.network.down, uploadThroughput: profile.network.up, latency: profile.network.latency });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  const started = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => (globalThis as any).__bench || (globalThis as any).__benchError, null, { timeout: 600_000, polling: 500 });
  const error = await page.evaluate(() => (globalThis as any).__benchError);
  if (error) throw new Error(error);
  const result = await page.evaluate(() => (globalThis as any).__bench);
  return { page, result: { ...result, wallMs: Date.now() - started, transferMB: bytes(), memoryMB: chromeMemoryMb() } };
}

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0) / Math.sqrt(a.reduce((s, x) => s + x * x, 0) * b.reduce((s, x) => s + x * x, 0));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const report: Record<string, unknown> = {};
let browserVectors: Record<string, number[][]> = {};
try {
  for (const profile of PROFILES) {
    const context = await browser.newContext();
    const blank = await context.newPage();
    await blank.goto("about:blank");
    const baselineMB = chromeMemoryMb();
    console.log(`\n${profile.name}: first visit (empty cache)…`);
    const cold = await visit(context, profile);
    console.log(`${profile.name}: repeat visit (cached)…`);
    const warm = await visit(context, profile);
    if (profile.cpu === 1) {
      browserVectors = {
        mean: await warm.page.evaluate((t) => (globalThis as any).__embed(t, "mean"), MATCH_TEXTS),
        cls: await warm.page.evaluate((t) => (globalThis as any).__embed(t, "cls"), MATCH_TEXTS),
      };
    }
    report[profile.name] = { baselineMemoryMB: baselineMB, firstVisit: cold.result, repeatVisit: warm.result };
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

// Do browser vectors match the server's? The catalog vectors were made by Workers AI.
const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
const serverVectors = ((await proxy.env.AI.run(EMBEDDING_MODEL, { text: MATCH_TEXTS })) as { data: number[][] }).data;
await Promise.race([proxy.dispose(), new Promise((r) => setTimeout(r, 5000))]);
for (const pooling of ["mean", "cls"] as const) {
  const sims = MATCH_TEXTS.map((_, i) => cosine(browserVectors[pooling]![i]!, serverVectors[i]!));
  report[`match with Workers AI (${pooling} pooling)`] = { min: +Math.min(...sims).toFixed(4), avg: +(sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(4) };
}

console.log(`\n${JSON.stringify(report, null, 2)}`);
process.exit(0);
