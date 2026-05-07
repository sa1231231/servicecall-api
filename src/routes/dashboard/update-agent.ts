import type { Request, Response } from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import {
  updateClientFields,
  getClientDocument,
  ConcurrencyError,
} from "../../config/client-store.js";
import { syncRetellDisplayLabels } from "../../lib/retell-display-sync.js";
import { validateClientFieldUpdates } from "../../lib/validate-client-fields.js";
import { logAudit } from "../../lib/audit.js";

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

  // Pull off the optional concurrency guard before validation.
  // The dashboard sends `_version` (the version it last saw) so a stale
  // edit fails loudly with 409 instead of silently overwriting.
  let expectedVersion: number | undefined;
  if ("_version" in body) {
    const v = body._version;
    if (v === null || v === undefined) {
      // explicit opt-out
    } else if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
      expectedVersion = v;
    } else {
      res.status(400).json({ error: "_version must be a non-negative integer" });
      return;
    }
    delete body._version;
  }
  if (Object.keys(body).length === 0) {
    res.status(400).json({ error: "Request body must contain at least one editable field" });
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

  const validationErrors = validateClientFieldUpdates(body);
  if (validationErrors.length > 0) {
    res.status(400).json({ error: validationErrors.join("; "), errors: validationErrors });
    return;
  }

  try {
    const before = await getClientDocument(slug);
    await updateClientFields(slug, body, { expectedVersion });
    const doc = await getClientDocument(slug);

    // Audit with before/after diff so changes are reviewable post-hoc.
    const fields = Object.keys(body);
    const beforeRec = (before ?? {}) as Record<string, unknown>;
    const afterRec = (doc ?? {}) as Record<string, unknown>;
    const diff: Record<string, { before: unknown; after: unknown }> = {};
    for (const k of fields) {
      diff[k] = { before: beforeRec[k], after: afterRec[k] };
    }
    await logAudit(req, "update_agent", slug, { fields, diff });

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
    if (err instanceof ConcurrencyError) {
      const fresh = await getClientDocument(slug);
      res.status(409).json({
        error: err.message,
        code: err.code,
        current_version: (fresh as { _version?: number } | null | undefined)?._version,
      });
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("not found") ? 404 : 400;
    res.status(status).json({ error: message });
  }
}
