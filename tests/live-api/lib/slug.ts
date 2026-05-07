import crypto from "crypto";

// Generate a slug for a live-API test artifact. Format:
//   e2e-{YYYY-MM-DD}-{6-hex-rand}
// Distinctive enough to filter on; the date prefix lets an operator
// inspecting the Twilio console see at a glance how stale a leak is.

export const E2E_PREFIX = "e2e-";

export function generateE2eSlug(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const rand = crypto.randomBytes(3).toString("hex"); // 6 hex chars
  return `${E2E_PREFIX}${date}-${rand}`;
}

export function isE2eSlug(slug: string): boolean {
  return slug.startsWith(E2E_PREFIX);
}

/** Parse the date portion of an e2e slug; returns null if not parseable. */
export function parseE2eSlugDate(slug: string): Date | null {
  if (!isE2eSlug(slug)) return null;
  const match = slug.slice(E2E_PREFIX.length).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const d = new Date(`${match[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True if the slug is older than `minHoursOld` hours. Used by the
 *  cleanup-stragglers script to avoid touching artifacts from a run
 *  that's currently in flight. */
export function isE2eSlugStale(slug: string, minHoursOld = 1): boolean {
  const d = parseE2eSlugDate(slug);
  if (!d) return false;
  const ageMs = Date.now() - d.getTime();
  return ageMs >= minHoursOld * 60 * 60 * 1000;
}
