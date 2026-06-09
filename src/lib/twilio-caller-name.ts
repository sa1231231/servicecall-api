import { config } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CallerNameLookup {
  /** Name registered to the phone number in carrier CNAM databases. For
   *  business landlines this is often the actual business name; for
   *  cell/consumer lines it's typically the subscriber's personal name. */
  callerName?: string;
  /** "BUSINESS" | "CONSUMER" — Twilio's classification. Empirically
   *  unreliable for our use case (small service businesses on personal
   *  cells get tagged CONSUMER even when the caller_name is the business),
   *  so don't gate behavior on this. Surfaced to the model for context. */
  callerType?: string;
  nationalFormat?: string;
  /** Twilio-side error code when the lookup couldn't resolve the name —
   *  not a fatal error, just means CNAM had no entry. */
  errorCode?: number;
}

export interface CallerNameResult {
  ok: boolean;
  phone: string;
  lookup?: CallerNameLookup;
  error?: string;
}

// ── Internals ────────────────────────────────────────────────────────────────

const LOOKUP_BASE = "https://lookups.twilio.com/v2/PhoneNumbers";

interface TwilioLookupResponse {
  caller_name?: {
    caller_name?: string;
    caller_type?: string;
    error_code?: number;
  };
  national_format?: string;
}

/** Normalize a phone string to E.164 (`+1...`). Returns null when the
 *  string can't be coerced to a 10-digit US number — Twilio's caller-
 *  name product is US/Canada only, so non-NANP numbers short-circuit. */
function toE164US(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  let ten = digits;
  if (digits.length === 11 && digits[0] === "1") ten = digits.slice(1);
  if (ten.length !== 10) return null;
  return `+1${ten}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Lookup the CNAM-registered name for a phone number. Fail-soft: any
 *  failure (missing creds, non-US number, Twilio error, network error)
 *  returns `{ ok: false, error }` and the pre-search bundle continues. */
export async function lookupCallerName(phone: string): Promise<CallerNameResult> {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    return { ok: false, phone, error: "Twilio credentials not configured" };
  }
  const e164 = toE164US(phone);
  if (!e164) {
    return {
      ok: false,
      phone,
      error: "phone is not a 10-digit US number — Twilio caller-name only supports NANP",
    };
  }
  const url = `${LOOKUP_BASE}/${encodeURIComponent(e164)}?Fields=caller_name`;
  const auth = Buffer.from(
    `${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`,
  ).toString("base64");
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        phone: e164,
        error: `Twilio Lookup ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as TwilioLookupResponse;
    const cn = data.caller_name;
    return {
      ok: true,
      phone: e164,
      lookup: {
        callerName: cn?.caller_name || undefined,
        callerType: cn?.caller_type || undefined,
        nationalFormat: data.national_format,
        errorCode: cn?.error_code ?? undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      phone: e164,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Render the lookup as a markdown block for the user message. Empty /
 *  missing names emit a "(no CNAM entry)" line so the model knows the
 *  channel was tried. */
export function formatCallerName(result?: CallerNameResult): string {
  if (!result) return "";
  const lines: string[] = [
    "## Twilio caller-name (CNAM)",
    "Carrier-registered name for the phone number. For B2B landlines this is often the actual business name; for cell/consumer lines it's typically the subscriber's personal name. The `caller_type` flag is unreliable — read the name itself. Treat this as one signal alongside Places/Brave/web_search, not authoritative. **It can match an owner's personal name and miss the business**, so always cross-check with the other channels.",
    "",
  ];
  if (!result.ok) {
    lines.push(`*(error: ${result.error})*`);
    lines.push("");
    return lines.join("\n");
  }
  const lk = result.lookup;
  if (!lk?.callerName) {
    lines.push(`*(no CNAM entry for ${result.phone})*`);
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`- **Name:** ${lk.callerName}`);
  if (lk.callerType) lines.push(`- **Type:** ${lk.callerType}`);
  if (lk.nationalFormat) lines.push(`- **Phone:** ${lk.nationalFormat}`);
  lines.push("");
  return lines.join("\n");
}
