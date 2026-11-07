import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogLoadFailure, HttpError, loadCatalog, loadVectors, onceUntilFailure } from "./data";

const meta = { generatedAt: "2026-11-07", source: "TMDB", people: ["A"], movies: [{ id: 1, title: "Heat", year: 1995, runtime: 170, genres: ["crime"], rating: 7.9, cast: [0], directors: [0] }] };

afterEach(() => vi.unstubAllGlobals());

describe("catalog loading", () => {
  it("loads and hydrates the catalog", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(meta)));
    const { catalog } = await loadCatalog();
    expect(catalog[0]).toMatchObject({ title: "Heat", cast: ["A"], directors: ["A"] });
  });

  it.each([
    ["a 404", async () => new Response("Not found", { status: 404 }), "missing"],
    ["the dev server's HTML page instead of JSON", async () => new Response("<!doctype html><html></html>"), "missing"],
    ["a server error", async () => new Response("", { status: 503 }), "failed"],
    ["a network failure", async () => Promise.reject(new TypeError("Failed to fetch")), "failed"],
  ] as const)("reports %s as %s", async (_, fetchImpl, expected) => {
    vi.stubGlobal("fetch", fetchImpl);
    const error = await loadCatalog().catch((e: unknown) => e);
    expect(catalogLoadFailure(error)).toBe(expected);
  });

  it("names the file and status in an HTTP error", () => {
    expect(new HttpError("data/catalog-meta.json", 503).message).toBe("data/catalog-meta.json: HTTP 503");
  });
});

describe("vector file loading", () => {
  const withVectors = { ...meta, vectors: { file: "catalog-vectors.test.bin", dimensions: 384 } } as Parameters<typeof loadVectors>[0];

  it("reports a failed vector download as an HTTP error, not as a broken file", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 502 }));
    await expect(loadVectors(withVectors)).rejects.toBeInstanceOf(HttpError);
  });

  it("rejects a vector file that does not match the catalog", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(10)));
    await expect(loadVectors(withVectors)).rejects.toThrow(/Re-run the seed/);
  });

  it("explains a catalog seeded without vectors", async () => {
    await expect(loadVectors(meta as Parameters<typeof loadVectors>[0])).rejects.toThrow(/without --dry-run/);
  });
});

describe("onceUntilFailure", () => {
  it("shares one load between callers and keeps the result", async () => {
    const once = onceUntilFailure<number>();
    const load = vi.fn(async () => 7);
    expect(await Promise.all([once(load), once(load)])).toEqual([7, 7]);
    expect(await once(load)).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads again on the next call after a failure", async () => {
    const once = onceUntilFailure<number>();
    const load = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(7);
    await expect(once(load)).rejects.toThrow("Failed to fetch");
    expect(await once(load)).toBe(7);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
