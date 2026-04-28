const SPIKE_THRESHOLD = 10;
const SPIKE_WINDOW_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;

const recentCalls = new Map<string, number[]>();
const lastAlerted = new Map<string, number>();

/**
 * Record a call for a client and return true if a spike is detected
 * (10+ calls in the last 5 minutes) and cooldown has expired.
 */
export function recordCall(clientSlug: string): { spike: boolean; count: number } {
  const now = Date.now();
  const cutoff = now - SPIKE_WINDOW_MS;

  // Get or create timestamps array
  let timestamps = recentCalls.get(clientSlug);
  if (!timestamps) {
    timestamps = [];
    recentCalls.set(clientSlug, timestamps);
  }

  // Add current call and trim old entries
  timestamps.push(now);
  const trimmed = timestamps.filter((t) => t > cutoff);
  recentCalls.set(clientSlug, trimmed);

  const count = trimmed.length;

  if (count >= SPIKE_THRESHOLD) {
    const lastAlert = lastAlerted.get(clientSlug) ?? 0;
    if (now - lastAlert > COOLDOWN_MS) {
      lastAlerted.set(clientSlug, now);
      return { spike: true, count };
    }
  }

  return { spike: false, count };
}
