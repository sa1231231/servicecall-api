import "dotenv/config";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

export const config = {
  // STRIPE_SIGNING_SECRET: requireEnv("STRIPE_SIGNING_SECRET"),
  // STRIPE_API_KEY: requireEnv("STRIPE_API_KEY"),
  // RETELL_SIGNATURE_KEY: requireEnv("RETELL_SIGNATURE_KEY"),
  GHL_API_KEY: requireEnv("GHL_API_KEY"),
  // RESEND_API_KEY: requireEnv("RESEND_API_KEY"),
  PORT: process.env.PORT || "3000",
};
