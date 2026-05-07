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

  // Anthropic API — used to enrich incoming leads via the local
  // `skills/onboarding-to-config/` bundle, which is loaded from disk on
  // every call (so editing SKILL.md tunes behavior without a redeploy).
  // Optional: if unset, intake still accepts rows but they land in
  // `failed` status so the operator can fill in fields manually.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
};
