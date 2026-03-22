import express from "express";
import { config } from "./config.js";
import { healthRouter } from "./routes/health.js";
import { stripeRouter } from "./routes/stripe/index.js";
import { retellRouter } from "./routes/retell/index.js";
import { deckscienceRouter } from "./routes/deckscience/index.js";
import { emailNotificationRouter } from "./routes/email-notification.js";

const app = express();

// Each route group applies its own middleware:
// - /stripe uses express.raw() for signature verification
// - /retell uses express.json() with rawBody capture for HMAC
// - /deckscience uses express.json()
// - /email-notification uses express.json()

app.use("/health", healthRouter);
// app.use("/stripe", stripeRouter);
// app.use("/retell", retellRouter);
app.use("/deckscience", deckscienceRouter);
app.use("/email-notification", emailNotificationRouter);

app.listen(Number(config.PORT), () => {
  console.log(`ServiceCall API listening on port ${config.PORT}`);
});
