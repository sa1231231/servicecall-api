import "dotenv/config";
function requireEnv(key) {
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
    API_KEY: requireEnv("API_KEY"),
    PORT: process.env.PORT || "3000",
    // Twilio SMS
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? "",
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? "",
    TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER ?? "",
    // Email (Resend)
    RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
    EMAIL_FROM: process.env.EMAIL_FROM ?? "notifications@servicecallsaver.com",
};
