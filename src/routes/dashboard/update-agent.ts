import type { Request, Response } from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { updateClientFields, getClientDocument } from "../../config/client-store.js";
import { syncRetellDisplayLabels } from "../../lib/retell-display-sync.js";

export async function updateAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = req.params.slug as string;
  const body = req.body;

  if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
    res.status(400).json({ error: "Request body must be a non-empty object" });
    return;
  }

  // Normalize empty-string display_name to null so the dashboard's fallback
  // (`display_name ?? name`) works rather than rendering a blank header.
  if ("display_name" in body) {
    const v = body.display_name;
    if (typeof v === "string") {
      const trimmed = v.trim();
      body.display_name = trimmed === "" ? null : trimmed;
    } else if (v !== null) {
      res.status(400).json({ error: "display_name must be a string or null" });
      return;
    }
  }

  for (const field of ["contact_name", "contact_phone", "contact_email", "contact_timezone", "contact_notes"]) {
    if (!(field in body)) continue;
    const v = body[field];
    if (typeof v === "string") {
      const trimmed = v.trim();
      body[field] = trimmed === "" ? null : trimmed;
    } else if (v !== null) {
      res.status(400).json({ error: `${field} must be a string or null` });
      return;
    }
  }

  try {
    await updateClientFields(slug, body);
    const doc = await getClientDocument(slug);

    // If the caller updated display_name, push the new label to Retell:
    //   - agent.agent_name (the console title)
    //   - phone-number nicknames bound to this agent
    // The label that goes to Retell is `display_name ?? name` so clearing the
    // display name reverts Retell to the business name.
    let displaySync: Awaited<ReturnType<typeof syncRetellDisplayLabels>> | undefined;
    if ("display_name" in body && doc?.agent_id) {
      const label = (doc.display_name && doc.display_name.trim()) || doc.name;
      const retell = new Retell({ apiKey: config.RETELL_API_KEY });
      try {
        displaySync = await syncRetellDisplayLabels(
          retell,
          slug,
          doc.agent_id,
          doc.outbound_from_number ?? null,
          label,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[update-agent] display_name push to Retell failed for ${slug}: ${msg}`);
        res.status(502).json({
          error: `Saved to MongoDB but failed to push display name to Retell: ${msg}`,
          doc,
        });
        return;
      }
    }

    const response: Record<string, unknown> = { success: true, doc };
    if (displaySync) response.display_sync = displaySync;
    res.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("not found") ? 404 : 400;
    res.status(status).json({ error: message });
  }
}
