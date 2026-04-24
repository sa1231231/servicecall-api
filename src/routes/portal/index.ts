import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { validatePortalToken } from "../../config/client-store.js";
import { portalGetAgentHandler } from "./get-agent.js";
import { portalGetCallsHandler } from "./get-calls.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const portalHtmlPath = path.join(__dirname, "../../../public/portal.html");

// ── Token auth middleware ─────────────────────────────────────────────────────

async function portalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const slug = String(req.params.slug);
  const token = String(req.query.token ?? "");

  if (!slug || !token) {
    res.status(401).json({ error: "Missing slug or token" });
    return;
  }

  const valid = await validatePortalToken(slug, token);
  if (!valid) {
    res.status(401).json({ error: "Invalid or expired portal link" });
    return;
  }

  (req as any).portalSlug = slug;
  next();
}

// ── Router ────────────────────────────────────────────────────────────────────

export const portalRouter = Router();

// Serve HTML (no token check — it's a static shell, API calls validate token)
portalRouter.get("/:slug", (_req, res) => {
  try {
    res.type("html").send(fs.readFileSync(portalHtmlPath, "utf8"));
  } catch (err) {
    console.error("[portal] failed to read portal.html:", portalHtmlPath, err);
    res.status(500).send("Portal not found");
  }
});

// API endpoints — require valid token
portalRouter.get("/:slug/api/agent", portalAuth, portalGetAgentHandler);
portalRouter.get("/:slug/api/calls", portalAuth, portalGetCallsHandler);
