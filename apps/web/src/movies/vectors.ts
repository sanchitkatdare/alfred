/**
 * Search vectors in the browser. File layout of catalog-vectors.bin: one row of 384 signed bytes per movie,
 * in the order of catalog-meta.json. Each row is scaled so its largest absolute value is 127; cosine
 * similarity ignores the scale, so no scale is stored.
 */
export const VECTOR_DIMENSIONS = 384;
/** Hard size limit for catalog-vectors.bin. 10k movies use 3.84 MB. */
export const VECTOR_FILE_BUDGET_BYTES = 4_000_000;
/**
 * Score bonus for popular movies: weight x log(votes) / log(max votes), so 0 to 0.15.
 * People describing a plot usually mean the well-known film. Tuned on 15 scene queries and
 * checked on 10 held-out ones (2026-10-05): first place 6 -> 11 of 15, held-out top 5: 7 -> 8 of 10.
 */
export const POPULARITY_WEIGHT = 0.15;

export function quantize(vector: ArrayLike<number>): Int8Array {
  let max = 0;
  for (let i = 0; i < vector.length; i++) max = Math.max(max, Math.abs(vector[i]!));
  return Int8Array.from(vector as ArrayLike<number>, (x) => (max ? Math.round((x / max) * 127) : 0));
}

export interface VectorIndex {
  ids: number[];
  rows: Int8Array;
  norms: Float32Array;
  /** Popularity bonus added to each row's score. */
  boosts: Float32Array;
  rowOf: Map<number, number>;
}

/** `votes` (same order as `ids`) enables the popularity bonus. */
export function createVectorIndex(ids: number[], rows: Int8Array, votes?: number[]): VectorIndex {
  if (rows.length !== ids.length * VECTOR_DIMENSIONS) {
    throw new Error(`Vector file has ${rows.length} values; expected ${ids.length} x ${VECTOR_DIMENSIONS}. Re-run the seed.`);
  }
  const norms = new Float32Array(ids.length);
  for (let r = 0; r < ids.length; r++) {
    let s = 0;
    for (let i = r * VECTOR_DIMENSIONS, end = i + VECTOR_DIMENSIONS; i < end; i++) s += rows[i]! * rows[i]!;
    norms[r] = Math.sqrt(s);
  }
  const boosts = new Float32Array(ids.length);
  if (votes) {
    const maxLog = Math.log10(1 + Math.max(0, ...votes)) || 1;
    votes.forEach((v, r) => (boosts[r] = (POPULARITY_WEIGHT * Math.log10(1 + Math.max(0, v))) / maxLog));
  }
  return { ids, rows, norms, boosts, rowOf: new Map(ids.map((id, r) => [id, r])) };
}

/** Ranks movies by cosine similarity plus popularity bonus. With `candidates`, only those movies are ranked. */
export function rankByVector(index: VectorIndex, query: ArrayLike<number>, candidates?: Iterable<number>, limit = 50): { id: number; score: number }[] {
  let qn = 0;
  for (let i = 0; i < query.length; i++) qn += query[i]! * query[i]!;
  qn = Math.sqrt(qn) || 1;
  const rowsToScore = candidates ? [...candidates].map((id) => index.rowOf.get(id)).filter((r): r is number => r !== undefined) : index.ids.map((_, r) => r);
  const scored = rowsToScore.map((r) => {
    let dot = 0;
    for (let i = 0, base = r * VECTOR_DIMENSIONS; i < VECTOR_DIMENSIONS; i++) dot += query[i]! * index.rows[base + i]!;
    return { id: index.ids[r]!, score: (index.norms[r] ? dot / (qn * index.norms[r]!) : 0) + index.boosts[r]! };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
