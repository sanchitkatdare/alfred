/** Vectorize getByIds is called in chunks of this size. The documented maximum is not known. */
const GET_BY_IDS_CHUNK = 20;

export async function getVectorsByIds(index: VectorizeIndex, ids: number[]): Promise<VectorizeVector[]> {
  const keys = ids.map(String);
  const chunks = Array.from({ length: Math.ceil(keys.length / GET_BY_IDS_CHUNK) }, (_, i) => keys.slice(i * GET_BY_IDS_CHUNK, (i + 1) * GET_BY_IDS_CHUNK));
  return (await Promise.all(chunks.map((c) => index.getByIds(c)))).flat();
}
