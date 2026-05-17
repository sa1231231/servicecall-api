import "dotenv/config";

// Live-API E2E test environment.
//
// All five vars must be set or the suite skips (no test runs, no errors).
// We separate this from the `src/__tests__/system.test.ts` env detection
// because the live-API suite hits Twilio + Retell DIRECTLY (in addition
// to the dashboard API) for verifier helpers — system.test.ts only
// touches the dashboard API itself, so it can run with fewer creds.

export interface LiveEnv {
  baseURL: string;
  apiKey: string;
  rootPassword: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  retellApiKey: string;
  // Optional — only needed by the leads test
  leadIntakeToken?: string;
  // Optional — only needed by the sheet-sync e2e test (leads-sheet-sync.test.ts)
  googleServiceAccountJson?: string;
  leadsSheetSync?: string;
}

const baseURL = (process.env.SYSTEM_TEST_URL || process.env.BASE_URL || process.env.E2E_BASE_URL || "").replace(/\/$/, "");
const apiKey = process.env.API_KEY || process.env.E2E_API_KEY || "";
const rootPassword = process.env.ROOT_PASSWORD || process.env.E2E_ROOT_PASSWORD || "";
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || "";
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || "";
const retellApiKey = process.env.RETELL_API_KEY || "";
const leadIntakeToken = process.env.LEAD_INTAKE_TOKEN || "";
const googleServiceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const leadsSheetSync = process.env.LEADS_SHEET_SYNC || "";

export const hasFullEnv =
  !!baseURL && baseURL.startsWith("http") &&
  !!apiKey &&
  !!rootPassword &&
  !!twilioAccountSid &&
  !!twilioAuthToken &&
  !!retellApiKey;

// The sheet-sync e2e test additionally needs the Google service-account
// key and the LEADS_SHEET_SYNC config — the same two vars set on the
// deployed service. It uses the dashboard API only (no Twilio/Retell), but
// reuses hasFullEnv so apiFetch's getLiveEnv() doesn't throw.
export const hasSheetSyncEnv =
  hasFullEnv && !!googleServiceAccountJson && !!leadsSheetSync;

export function getLiveEnv(): LiveEnv {
  if (!hasFullEnv) {
    throw new Error(
      "Live E2E env missing. Need: SYSTEM_TEST_URL/BASE_URL, API_KEY, " +
      "ROOT_PASSWORD, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, RETELL_API_KEY.",
    );
  }
  return {
    baseURL,
    apiKey,
    rootPassword,
    twilioAccountSid,
    twilioAuthToken,
    retellApiKey,
    leadIntakeToken: leadIntakeToken || undefined,
    googleServiceAccountJson: googleServiceAccountJson || undefined,
    leadsSheetSync: leadsSheetSync || undefined,
  };
}

/** Print which vars are missing — useful for the "skip" message. */
export function describeMissingEnv(): string {
  const missing: string[] = [];
  if (!baseURL || !baseURL.startsWith("http")) missing.push("SYSTEM_TEST_URL");
  if (!apiKey) missing.push("API_KEY");
  if (!rootPassword) missing.push("ROOT_PASSWORD");
  if (!twilioAccountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!twilioAuthToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!retellApiKey) missing.push("RETELL_API_KEY");
  return missing.length === 0 ? "(all env present)" : `missing: ${missing.join(", ")}`;
}
