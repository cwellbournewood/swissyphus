/**
 * Tiny concurrency limiter. CPU-heavy work (parsing multi-MB open-data
 * files) runs on the one event loop; bounding how many such jobs run at once
 * keeps a burst of heavy requests from starving every other request.
 */
export function createLimiter(max: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= max) return;
    const run = queue.shift();
    if (run) run();
  };
  return <T>(job: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        job()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

/** Shared limiter for heavy resource parsing across all catalogue modules. */
export const heavyParse = createLimiter(2);

/** Race a promise against a timeout, always clearing the timer. */
export async function withDeadline<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
