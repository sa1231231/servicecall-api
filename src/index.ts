import express from "express";
import { config } from "./config.js";
import { healthRouter } from "./routes/health.js";
import { stripeRouter } from "./routes/stripe/index.js";
import { retellRouter } from "./routes/retell/index.js";
import { deckscienceRouter } from "./routes/deckscience/index.js";
import { emailNotificationRouter } from "./routes/email-notification.js";

const app = express();

app.use((req, res, next) => {
  const start = Date.now();
  console.log(`--> ${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    headers: {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
    },
    query: Object.keys(req.query).length ? req.query : undefined,
  });

  res.on("finish", () => {
    console.log(`<-- ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
  });

  next();
});

app.use("/health", healthRouter);

app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (key !== config.API_KEY) {
    console.log(`[auth] rejected request to ${req.originalUrl}`);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// app.use("/stripe", stripeRouter);
// app.use("/retell", retellRouter);
app.use("/deckscience", deckscienceRouter);
app.use("/email-notification", emailNotificationRouter);

app.listen(Number(config.PORT), () => {
  console.log(`ServiceCall API listening on port ${config.PORT}`);
});
