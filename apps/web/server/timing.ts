/** Records step durations and formats them as a Server-Timing header. */
export function createTimer() {
  const steps: { name: string; ms: number }[] = [];
  return {
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        steps.push({ name, ms: Math.round(performance.now() - start) });
      }
    },
    steps: () => Object.fromEntries(steps.map((s) => [s.name, s.ms])),
    header: () => steps.map((s) => `${s.name};dur=${s.ms}`).join(", "),
  };
}

/** Rejects if the call takes longer than `ms`. Workers AI calls can stall; the user should get an answer either way. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
