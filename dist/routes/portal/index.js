import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express, { Router } from "express";
import { validatePortalToken, findClientsByEmail, generatePortalToken, getClientDocument, updateClientFields, loadClientsFromDb, } from "../../config/client-store.js";
import { sendEmail } from "../../lib/notify-email.js";
import { portalGetAgentHandler } from "./get-agent.js";
import { portalGetCallsHandler } from "./get-calls.js";
import { ownerConfig } from "../../config/notification-clients.js";
import { logAudit } from "../../lib/audit.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const portalHtmlPath = path.join(__dirname, "../../../public/portal.html");
// ── Token auth middleware ─────────────────────────────────────────────────────
async function portalAuth(req, res, next) {
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
    req.portalSlug = slug;
    next();
}
// ── Router ────────────────────────────────────────────────────────────────────
export const portalRouter = Router();
portalRouter.use(express.json());
// ── Magic link request (no auth — must be before /:slug catch-all) ───────────
portalRouter.post("/request-link", async (req, res) => {
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
        const links = [];
        const linksHtml = [];
        for (const client of matches) {
            const token = client.portal_token || (await generatePortalToken(client._id));
            const url = `${baseUrl}/portal/${client._id}?token=${token}`;
            links.push(`${client.name}: ${url}`);
            linksHtml.push(`<p><strong>${client.name}</strong><br><a href="${url}">${url}</a></p>`);
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
    }
    catch (err) {
        console.error("[portal] failed to send magic link:", err);
    }
    res.json({ success: true, message: successMsg });
});
// Serve HTML (no token check — it's a static shell, API calls validate token)
portalRouter.get("/:slug", (_req, res) => {
    try {
        res.type("html").send(fs.readFileSync(portalHtmlPath, "utf8"));
    }
    catch (err) {
        console.error("[portal] failed to read portal.html:", portalHtmlPath, err);
        res.status(500).send("Portal not found");
    }
});
// API endpoints — require valid token
portalRouter.get("/:slug/api/agent", portalAuth, portalGetAgentHandler);
portalRouter.get("/:slug/api/calls", portalAuth, portalGetCallsHandler);
// ── Self-serve dispatch settings ─────────────────────────────────────────────
const PHONE_RE = /^\+1\d{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
portalRouter.patch("/:slug/api/settings", portalAuth, async (req, res) => {
    const slug = req.portalSlug;
    try {
        const doc = await getClientDocument(slug);
        if (!doc) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }
        const body = req.body;
        if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
            res.status(400).json({ error: "Request body must be a non-empty object" });
            return;
        }
        const PORTAL_EDITABLE = new Set([
            "dispatch_text_numbers",
            "dispatch_email",
            "dispatch_call_number",
            "dispatch_by_type",
        ]);
        const updates = {};
        const errors = [];
        for (const [key, value] of Object.entries(body)) {
            if (!PORTAL_EDITABLE.has(key))
                continue;
            if (key === "dispatch_text_numbers") {
                if (!Array.isArray(value)) {
                    errors.push("dispatch_text_numbers must be an array");
                    continue;
                }
                // Re-add owner phone if it was in the original list
                const nums = value.filter((n) => typeof n === "string" && n.trim());
                for (const n of nums) {
                    if (!PHONE_RE.test(n))
                        errors.push(`Invalid phone number "${n}". Format: +1XXXXXXXXXX.`);
                }
                // Ensure owner phone stays if it was there
                if (ownerConfig.phone && doc.dispatch_text_numbers?.includes(ownerConfig.phone) && !nums.includes(ownerConfig.phone)) {
                    nums.unshift(ownerConfig.phone);
                }
                updates.dispatch_text_numbers = nums;
            }
            if (key === "dispatch_email") {
                if (!Array.isArray(value)) {
                    errors.push("dispatch_email must be an array");
                    continue;
                }
                const emails = value.filter((e) => typeof e === "string" && e.trim());
                for (const e of emails) {
                    if (!EMAIL_RE.test(e))
                        errors.push(`Invalid email "${e}".`);
                }
                // Ensure owner email stays if it was there
                if (ownerConfig.email && doc.dispatch_email?.includes(ownerConfig.email) && !emails.includes(ownerConfig.email)) {
                    emails.unshift(ownerConfig.email);
                }
                updates.dispatch_email = emails.length > 0 ? emails : null;
            }
            if (key === "dispatch_call_number") {
                const num = typeof value === "string" ? value.trim() : "";
                if (num && !PHONE_RE.test(num))
                    errors.push(`Invalid call number "${num}". Format: +1XXXXXXXXXX.`);
                updates.dispatch_call_number = num || null;
            }
            if (key === "dispatch_by_type" && typeof value === "object" && value !== null) {
                const existingDbt = doc.dispatch_by_type || {};
                const newDbt = { ...existingDbt };
                for (const [pathKey, override] of Object.entries(value)) {
                    if (!existingDbt[pathKey])
                        continue; // only edit existing overrides
                    const o = {};
                    if (Array.isArray(override.dispatch_text_numbers)) {
                        const nums = override.dispatch_text_numbers.filter((n) => typeof n === "string" && n.trim());
                        for (const n of nums) {
                            if (!PHONE_RE.test(n))
                                errors.push(`Invalid phone "${n}" in override "${pathKey}".`);
                        }
                        // Protect owner phone
                        if (ownerConfig.phone && existingDbt[pathKey]?.dispatch_text_numbers?.includes(ownerConfig.phone) && !nums.includes(ownerConfig.phone)) {
                            nums.unshift(ownerConfig.phone);
                        }
                        o.dispatch_text_numbers = nums;
                    }
                    if (Array.isArray(override.dispatch_email)) {
                        const emails = override.dispatch_email.filter((e) => typeof e === "string" && e.trim());
                        for (const e of emails) {
                            if (!EMAIL_RE.test(e))
                                errors.push(`Invalid email "${e}" in override "${pathKey}".`);
                        }
                        o.dispatch_email = emails;
                    }
                    if (typeof override.dispatch_call_number === "string") {
                        const num = override.dispatch_call_number.trim();
                        if (num && !PHONE_RE.test(num))
                            errors.push(`Invalid call number "${num}" in override "${pathKey}".`);
                        o.dispatch_call_number = num || null;
                    }
                    newDbt[pathKey] = { ...existingDbt[pathKey], ...o };
                }
                updates.dispatch_by_type = newDbt;
            }
        }
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed", errors });
            return;
        }
        if (Object.keys(updates).length === 0) {
            res.status(400).json({ error: "No valid fields to update" });
            return;
        }
        await updateClientFields(slug, updates);
        await loadClientsFromDb();
        // Audit
        await logAudit({ ...req, user: { username: `portal:${slug}`, role: "portal" } }, "portal_update_settings", slug, { fields: Object.keys(updates) });
        // Return updated config (filtered same as GET)
        const updated = await getClientDocument(slug);
        if (!updated) {
            res.json({ success: true });
            return;
        }
        const textNumbers = (updated.dispatch_text_numbers || []).filter((n) => n !== ownerConfig.phone);
        const emails = (updated.dispatch_email || []).filter((e) => e !== ownerConfig.email);
        const callNumber = updated.dispatch_call_number === ownerConfig.phone ? null : updated.dispatch_call_number;
        res.json({
            success: true,
            dispatch_text_numbers: textNumbers,
            dispatch_call_number: callNumber,
            dispatch_email: emails.length > 0 ? emails : null,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(500).json({ error: message });
    }
});
