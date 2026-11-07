/**
 * Screenshots of the page at phone, tablet, desktop and wide sizes, and a check for horizontal scrolling.
 * Needs a running server (`pnpm --filter @alfred/web dev:api`) and Google Chrome. One search per size: about 0.2 neurons.
 *
 *   pnpm --filter @alfred/web screenshots [--url http://localhost:8788] [--out .cache/screenshots]
 */
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values: cli } = parseArgs({ options: { url: { type: "string", default: "http://localhost:8788" }, out: { type: "string", default: ".cache/screenshots" } } });
const SIZES = [
  { name: "phone", width: 375, height: 812, mobile: true },
  { name: "tablet", width: 768, height: 1024, mobile: true },
  { name: "desktop", width: 1280, height: 800, mobile: false },
  { name: "wide", width: 1920, height: 1080, mobile: false },
];

await mkdir(cli.out!, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const failures: string[] = [];
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile });
    await page.goto(cli.url!);
    await page.locator("#q").waitFor();
    const overflow = async (state: string) => {
      const extra: number = await page.evaluate("document.documentElement.scrollWidth - window.innerWidth");
      if (extra > 0) failures.push(`${size.name}, ${state}: page scrolls sideways by ${extra} px`);
    };
    await page.locator("#q:not([disabled])").waitFor();
    await overflow("start");
    await page.screenshot({ path: `${cli.out}/${size.name}-start.png`, fullPage: true });
    await page.locator("#q").fill("like inception but not sci-fi, under 2 hours");
    await page.locator("#q").press("Enter");
    await page.getByRole("heading", { name: "Best matches by meaning" }).waitFor();
    // Wait for the layout switch animation to end, so the screenshot shows the settled page.
    await page.waitForFunction("document.getAnimations().length === 0");
    await overflow("search");
    await page.screenshot({ path: `${cli.out}/${size.name}-search.png`, fullPage: true });
    await page.close();
    console.log(`${size.name} (${size.width}x${size.height}): done`);
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`No horizontal scrolling. Screenshots in ${cli.out}.`);
