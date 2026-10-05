import { describe, expect, it } from "vitest";
import { createVectorIndex, quantize, rankByVector, VECTOR_DIMENSIONS } from "./vectors";

const vec = (seed: number) => Array.from({ length: VECTOR_DIMENSIONS }, (_, i) => Math.sin(seed * 7.1 + i * 0.37));

function index(seeds: number[]) {
  const rows = new Int8Array(seeds.length * VECTOR_DIMENSIONS);
  seeds.forEach((s, r) => rows.set(quantize(vec(s)), r * VECTOR_DIMENSIONS));
  return createVectorIndex(seeds.map((s) => s * 10), rows);
}

describe("vector index", () => {
  it("quantizes to signed bytes with the largest value at 127", () => {
    const q = quantize([0.5, -0.25, 0.1]);
    expect(Array.from(q)).toEqual([127, -63, 25]); // -63.5 rounds up
  });

  it("ranks the matching vector first with a score near 1", () => {
    const idx = index([1, 2, 3, 4]);
    const [best] = rankByVector(idx, vec(3));
    expect(best!.id).toBe(30);
    expect(best!.score).toBeGreaterThan(0.99);
  });

  it("ranks only the given candidates", () => {
    const idx = index([1, 2, 3, 4]);
    expect(rankByVector(idx, vec(3), [10, 20]).map((r) => r.id).sort()).toEqual([10, 20]);
  });

  it("lets popularity decide between near-identical matches", () => {
    const rows = new Int8Array(2 * VECTOR_DIMENSIONS);
    rows.set(quantize(vec(3)), 0);
    rows.set(quantize(vec(3)), VECTOR_DIMENSIONS);
    const idx = createVectorIndex([1, 2], rows, [10, 50_000]);
    expect(rankByVector(idx, vec(3)).map((r) => r.id)).toEqual([2, 1]);
  });

  it("rejects a vector file that does not match the catalog", () => {
    expect(() => createVectorIndex([1, 2], new Int8Array(VECTOR_DIMENSIONS))).toThrow(/Re-run the seed/);
  });
});
