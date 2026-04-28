import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express, { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import {
  validatePortalToken,
  findClientsByEmail,
  generatePortalToken,
} from "../../config/client-store.js";
import { sendEmail } from "../../lib/notify-email.js";
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
portalRouter.use(express.json());

// ── Magic link request (no auth — must be before /:slug catch-all) ───────────

portalRouter.post("/request-link", async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();

  // Always return success to prevent email enumeration
  const successMsg = "If that email is associated with an account, you'll receive a login link shortly.";

  if (!email || !email.includes("@")) {
    res.json({ success: true, message: successMsg });
    return;
  }

  try {
    const matches = await findClientsByEmail(email);
    if (matches.length === 0) {
      res.json({ success: true, message: successMsg });
      return;
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const links: string[] = [];
    const linksHtml: string[] = [];

    for (const client of matches) {
      const token = client.portal_token || (await generatePortalToken(client._id));
      const url = `${baseUrl}/portal/${client._id}?token=${token}`;
      links.push(`${client.name}: ${url}`);
      linksHtml.push(
        `<p><strong>${client.name}</strong><br><a href="${url}">${url}</a></p>`,
      );
    }

    const textBody = [
      "Hi,",
      "",
      "Here's your portal link to view call history and details:",
      "",
      ...links,
      "",
      "— Service Call Saver",
    ].join("\n");

    const htmlBody = [
      "<p>Hi,</p>",
      "<p>Here's your portal link to view call history and details:</p>",
      ...linksHtml,
      "<br><p style='color:#888;'>— Service Call Saver</p>",
    ].join("");

    await sendEmail({
      to: email,
      subject: "Your Service Call Saver Portal Link",
      body: textBody,
      html: htmlBody,
    });

    console.log(`[portal] sent magic link to ${email} for ${matches.length} client(s)`);
  } catch (err) {
    console.error("[portal] failed to send magic link:", err);
  }

  res.json({ success: true, message: successMsg });
});

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
