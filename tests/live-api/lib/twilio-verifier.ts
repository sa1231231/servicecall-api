import twilio from "twilio";
import { getLiveEnv } from "./env.js";

// Direct Twilio API verifiers used by E2E tests to confirm outbound
// effects (an SMS was queued, a number is/isn't owned by the account).

let _client: ReturnType<typeof twilio> | null = null;
function client() {
  if (_client) return _client;
  const env = getLiveEnv();
  _client = twilio(env.twilioAccountSid, env.twilioAuthToken);
  return _client;
}

/** Returns true if Twilio shows a recent outbound SMS to `to` within the
 *  last `withinSeconds` seconds. Polls up to `timeoutMs` to handle the
 *  ~1-2s delay between API enqueue and Messages API visibility. */
export async function smsSentTo(
  to: string,
  withinSeconds = 60,
  timeoutMs = 15000,
): Promise<boolean> {
  const since = new Date(Date.now() - withinSeconds * 1000);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const messages = await client().messages.list({
      to,
      dateSentAfter: since,
      limit: 5,
    });
    if (messages.length > 0) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Throws if `to` did NOT receive an SMS recently. */
export async function assertSmsSentTo(to: string, withinSeconds = 60): Promise<void> {
  const ok = await smsSentTo(to, withinSeconds);
  if (!ok) {
    throw new Error(`No outbound SMS to ${to} found in Twilio in the last ${withinSeconds}s`);
  }
}

/** True if the account currently owns the given phone number (E.164). */
export async function ownsNumber(phoneE164: string): Promise<boolean> {
  const list = await client().incomingPhoneNumbers.list({ phoneNumber: phoneE164, limit: 1 });
  return list.length > 0;
}

export async function assertNumberOwned(phoneE164: string): Promise<void> {
  if (!(await ownsNumber(phoneE164))) {
    throw new Error(`Twilio account does not own ${phoneE164}`);
  }
}

export async function assertNumberReleased(phoneE164: string): Promise<void> {
  if (await ownsNumber(phoneE164)) {
    throw new Error(`Twilio account still owns ${phoneE164} (expected released)`);
  }
}

/** List all numbers whose friendlyName starts with `prefix` (e.g. "e2e-").
 *  Used by the cleanup sweeper to find stragglers. */
export async function listNumbersWithFriendlyNamePrefix(prefix: string): Promise<Array<{ sid: string; phoneNumber: string; friendlyName: string }>> {
  // Twilio's API doesn't support friendlyName prefix filtering server-side,
  // so we fetch the full account list and filter client-side. Safe for a
  // workspace with <500 active numbers.
  const list = await client().incomingPhoneNumbers.list({ limit: 1000 });
  return list
    .filter((n) => n.friendlyName?.startsWith(prefix))
    .map((n) => ({ sid: n.sid, phoneNumber: n.phoneNumber, friendlyName: n.friendlyName ?? "" }));
}

/** Release a Twilio number by SID. Used by cleanup sweeper. */
export async function releaseNumberBySid(sid: string): Promise<void> {
  await client().incomingPhoneNumbers(sid).remove();
}
