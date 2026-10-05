export interface Env {
  AI: Ai;
}

/** Embedding model. Changing it requires re-running the seed: catalog vectors and query vectors must come from the same model. */
export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBEDDING_DIMENSIONS = 384;
