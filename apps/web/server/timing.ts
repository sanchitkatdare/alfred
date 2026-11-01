/** Rejects if the call takes longer than `ms`. Workers AI calls can stall; the user should get an answer either way. */
export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
