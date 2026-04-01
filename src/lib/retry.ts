export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, label = "operation" } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt === maxAttempts) {
        console.error(
          `retry: ${label} failed after ${maxAttempts} attempts — ${err.message}`,
        );
        throw err;
      }
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `retry: ${label} attempt ${attempt}/${maxAttempts} failed — retrying in ${delay}ms — ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error(`retry: ${label} exhausted`);
}
