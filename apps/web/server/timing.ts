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
