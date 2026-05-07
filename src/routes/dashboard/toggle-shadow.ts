import type { Request, Response } from "express";
import { updateClientField } from "../../config/client-store.js";
import { logAudit } from "../../lib/audit.js";

export async function toggleShadowHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = req.params.slug as string;
  const { shadow_mode } = req.body;

  if (typeof shadow_mode !== "boolean") {
    res.status(400).json({ error: "shadow_mode must be a boolean" });
    return;
  }

  try {
    await updateClientField(slug, "shadow_mode", shadow_mode);
    await logAudit(req, "toggle_shadow", slug, { shadow_mode });
    res.json({ success: true, slug, shadow_mode });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(404).json({ error: message });
  }
}
