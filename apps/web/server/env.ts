export interface Env {
  AI: Ai;
  VECTORIZE_MOVIES: VectorizeIndex;
}

/** Embedding model. Changing it requires a new Vectorize index (dimensions are fixed at creation). */
export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBEDDING_DIMENSIONS = 384;
