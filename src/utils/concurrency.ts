// Bounded-concurrency async helpers.
//
// Autotask enforces a per-integration concurrent-thread limit (HTTP 429
// "API thread threshold of N threads has been exceeded"). Fanning out one
// API call per result row with an unbounded Promise.allSettled blows that
// limit on broad result sets, so most calls 429 and their data is lost.
// mapWithConcurrency caps how many mappers run at once.

/**
 * Run `fn` over `items` with at most `limit` invocations in flight at once.
 *
 * Behaves like `Promise.allSettled(items.map(fn))` — results are returned in
 * input order and a rejected mapper produces a `{ status: 'rejected' }` entry
 * rather than aborting the batch — but never exceeds `limit` concurrency.
 *
 * @param items Items to map over.
 * @param limit Maximum number of concurrent invocations (coerced to >= 1).
 * @param fn Async mapper, receives the item and its index.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const maxConcurrency = Math.max(1, Math.floor(limit) || 1);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (let index = nextIndex++; index < items.length; index = nextIndex++) {
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(maxConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Create a limiter that runs async tasks with at most `limit` in flight at
 * once; excess tasks queue FIFO. Unlike mapWithConcurrency it is for ad-hoc
 * callers that arrive independently (e.g. parallel id lookups that share one
 * Autotask thread budget). A rejected task rejects only its own promise.
 */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(limit) || 1);
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active++;
        let started: Promise<T>;
        try {
          started = Promise.resolve(task());
        } catch (err) {
          started = Promise.reject(err);
        }
        started.then(resolve, reject).finally(release);
      };
      if (active < max) run();
      else queue.push(run);
    });
}
