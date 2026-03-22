import "dotenv/config";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

export const config = {
  STRIPE_SIGNING_SECRET: process.env.STRIPE_SIGNING_SECRET ?? "",
  STRIPE_API_KEY: process.env.STRIPE_API_KEY ?? "",
  RETELL_SIGNATURE_KEY: process.env.RETELL_SIGNATURE_KEY ?? "",
  GHL_API_KEY: requireEnv("GHL_API_KEY"),
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
  API_KEY: requireEnv("API_KEY"),
  PORT: process.env.PORT || "3000",
};
