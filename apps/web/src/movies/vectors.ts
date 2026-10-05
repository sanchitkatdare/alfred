/**
 * Search vectors in the browser. File layout of catalog-vectors.bin: one row of 384 signed bytes per movie,
 * in the order of catalog-meta.json. Each row is scaled so its largest absolute value is 127; cosine
 * similarity ignores the scale, so no scale is stored.
 */
export const VECTOR_DIMENSIONS = 384;
/** Hard size limit for catalog-vectors.bin. 10k movies use 3.84 MB. */
export const VECTOR_FILE_BUDGET_BYTES = 4_000_000;

export function quantize(vector: ArrayLike<number>): Int8Array {
  let max = 0;
  for (let i = 0; i < vector.length; i++) max = Math.max(max, Math.abs(vector[i]!));
  return Int8Array.from(vector as ArrayLike<number>, (x) => (max ? Math.round((x / max) * 127) : 0));
}

export interface VectorIndex {
  ids: number[];
  rows: Int8Array;
  norms: Float32Array;
  rowOf: Map<number, number>;
}

export function createVectorIndex(ids: number[], rows: Int8Array): VectorIndex {
  if (rows.length !== ids.length * VECTOR_DIMENSIONS) {
    throw new Error(`Vector file has ${rows.length} values; expected ${ids.length} x ${VECTOR_DIMENSIONS}. Re-run the seed.`);
  }
  const norms = new Float32Array(ids.length);
  for (let r = 0; r < ids.length; r++) {
    let s = 0;
    for (let i = r * VECTOR_DIMENSIONS, end = i + VECTOR_DIMENSIONS; i < end; i++) s += rows[i]! * rows[i]!;
    norms[r] = Math.sqrt(s);
  }
  return { ids, rows, norms, rowOf: new Map(ids.map((id, r) => [id, r])) };
}

/** Ranks movies by cosine similarity to the query vector. With `candidates`, only those movies are ranked. */
export function rankByVector(index: VectorIndex, query: ArrayLike<number>, candidates?: Iterable<number>, limit = 50): { id: number; score: number }[] {
  let qn = 0;
  for (let i = 0; i < query.length; i++) qn += query[i]! * query[i]!;
  qn = Math.sqrt(qn) || 1;
  const rowsToScore = candidates ? [...candidates].map((id) => index.rowOf.get(id)).filter((r): r is number => r !== undefined) : index.ids.map((_, r) => r);
  const scored = rowsToScore.map((r) => {
    let dot = 0;
    for (let i = 0, base = r * VECTOR_DIMENSIONS; i < VECTOR_DIMENSIONS; i++) dot += query[i]! * index.rows[base + i]!;
    return { id: index.ids[r]!, score: index.norms[r] ? dot / (qn * index.norms[r]!) : 0 };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
