import "dotenv/config";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

export const config = {
  RETELL_SIGNATURE_KEY: requireEnv("RETELL_SIGNATURE_KEY"),
  RETELL_API_KEY: requireEnv("RETELL_API_KEY"),
  GHL_API_KEY: requireEnv("GHL_API_KEY"),

  API_KEY: requireEnv("API_KEY"),
  PORT: process.env.PORT || "3000",

  // Twilio SMS
  TWILIO_ACCOUNT_SID: requireEnv("TWILIO_ACCOUNT_SID"),
  TWILIO_AUTH_TOKEN: requireEnv("TWILIO_AUTH_TOKEN"),
  TWILIO_PHONE_NUMBER: requireEnv("TWILIO_PHONE_NUMBER"),

  // Email (Resend)
  RESEND_API_KEY: requireEnv("RESEND_API_KEY"),
  EMAIL_FROM: process.env.EMAIL_FROM ?? "notifications@servicecallsaver.com",

  // Twilio provisioning
  TWILIO_TRUNK_SID: process.env.TWILIO_TRUNK_SID ?? "",
  TWILIO_EMERGENCY_ADDRESS_SID: process.env.TWILIO_EMERGENCY_ADDRESS_SID ?? "",
  TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID ?? "",

  // Retell BYOC outbound trunk auth — applied to every Retell phone number we
  // provision so warm transfer can route outbound through the Twilio trunk.
  // Username matches the Twilio credential list user; password is digest auth.
  RETELL_SIP_TRUNK_AUTH_USERNAME: process.env.RETELL_SIP_TRUNK_AUTH_USERNAME ?? "",
  RETELL_SIP_TRUNK_AUTH_PASSWORD: process.env.RETELL_SIP_TRUNK_AUTH_PASSWORD ?? "",

  // Google Review
  GOOGLE_REVIEW_URL: process.env.GOOGLE_REVIEW_URL ?? "",

  // MongoDB
  MONGODB_URL: requireEnv("MONGODB_URL"),

  // R2 Backup (optional)
  R2_ENDPOINT: process.env.R2_ENDPOINT ?? "",
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? "",
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? "",
  R2_BUCKET: process.env.R2_BUCKET ?? "scs-mongo-backup",

  // Root account password (break-glass access)
  ROOT_PASSWORD: requireEnv("ROOT_PASSWORD"),

  // HMAC key for signing session cookies. Kept SEPARATE from ROOT_PASSWORD
  // so a leaked break-glass password can't be used to forge sessions for
  // arbitrary users, and so rotating one doesn't auto-invalidate the
  // other. Adding/changing this env logs every active user out exactly
  // once — they re-login, the new key signs going forward.
  SESSION_SECRET: requireEnv("SESSION_SECRET"),

  // Anthropic API — used to enrich incoming leads via the local
  // `skills/onboarding-to-config/` bundle, which is loaded from disk on
  // every call (so editing SKILL.md tunes behavior without a redeploy).
  // Optional: if unset, intake still accepts rows but they land in
  // `failed` status so the operator can fill in fields manually.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",

  // Google Places API (New) — primary phone-number-to-business
  // resolver since it sits on top of Google Business Profile data,
  // which is where small service businesses actually live. Used
  // alongside Custom Search; both pre-searches are baked into the
  // user message before the skill is called. Required at boot.
  GOOGLE_PLACES_API_KEY: requireEnv("GOOGLE_PLACES_API_KEY"),

  // Google Programmable Search Engine — long-tail web context for
  // lead enrichment (Yelp, Nextdoor, Facebook, BBB, contractor-locator
  // pages). Replaces Brave because Google's index has the small-service
  // business listings Brave was missing. Requires both an API key
  // (Custom Search API enabled on the Cloud project) and the cx id of a
  // Programmable Search Engine configured to search the entire web.
  GOOGLE_CUSTOM_SEARCH_API_KEY: requireEnv("GOOGLE_CUSTOM_SEARCH_API_KEY"),
  GOOGLE_CUSTOM_SEARCH_CX: requireEnv("GOOGLE_CUSTOM_SEARCH_CX"),

  // Shared secret for the Google Apps Script lead sync. Optional —
  // when unset, POST /api/leads/intake returns 401 for everyone, so
  // the integration is effectively off. Rotate by changing this and
  // the matching Script Property in the Sheet's Apps Script project.
  LEAD_INTAKE_TOKEN: process.env.LEAD_INTAKE_TOKEN ?? "",
};
