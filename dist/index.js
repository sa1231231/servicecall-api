import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { healthRouter } from "./routes/health.js";
import { retellRouter } from "./routes/retell/index.js";
import { deckscienceRouter } from "./routes/deckscience/index.js";
import { agentsRouter } from "./routes/agents/index.js";
import { loadJsonClients } from "./config/load-json-clients.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
});
// Lenient limiter for Retell webhooks — they may burst multiple calls
const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
});
const app = express();
app.use(globalLimiter);
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
app.use("/retell", webhookLimiter, retellRouter);
const formRouter = express.Router();
const formHtmlPath = path.join(__dirname, "..", "public", "index.html");
formRouter.get("/", (_req, res) => {
    try {
        res.type("html").send(fs.readFileSync(formHtmlPath, "utf8"));
    }
    catch (err) {
        console.error("[form] failed to read index.html:", formHtmlPath, err);
        res.status(500).send("Form not found");
    }
});
formRouter.get("/config", (_req, res) => {
    res.json({ apiKey: config.API_KEY });
});
app.use("/form", formRouter);
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
app.use("/deckscience", deckscienceRouter);
app.use("/agents", agentsRouter);
loadJsonClients();
app.listen(Number(config.PORT), () => {
    console.log(`ServiceCall API listening on port ${config.PORT}`);
});
