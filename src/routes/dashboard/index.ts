import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Router } from "express";
import express from "express";
import { config } from "../../config.js";
import { listAgentsHandler } from "./list-agents.js";
import { toggleShadowHandler } from "./toggle-shadow.js";
import { getAgentHandler } from "./get-agent.js";
import { getCallsHandler } from "./get-calls.js";
import { updateAgentHandler } from "./update-agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardHtmlPath = path.join(__dirname, "../../../public/dashboard.html");

// Public routes (no auth): serves HTML and config
export const dashboardRouter = Router();

dashboardRouter.get("/", (_req, res) => {
  try {
    res.type("html").send(fs.readFileSync(dashboardHtmlPath, "utf8"));
  } catch (err) {
    console.error("[dashboard] failed to read dashboard.html:", dashboardHtmlPath, err);
    res.status(500).send("Dashboard not found");
  }
});

dashboardRouter.get("/config", (_req, res) => {
  res.json({ apiKey: config.API_KEY });
});

// Authenticated API routes
export const dashboardApiRouter = Router();
dashboardApiRouter.use(express.json());

dashboardApiRouter.get("/agents", listAgentsHandler);
dashboardApiRouter.get("/agents/:slug", getAgentHandler);
dashboardApiRouter.get("/agents/:slug/calls", getCallsHandler);
dashboardApiRouter.patch("/agents/:slug/shadow", toggleShadowHandler);
dashboardApiRouter.patch("/agents/:slug", updateAgentHandler);
