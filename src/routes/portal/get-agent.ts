import type { Request, Response } from "express";
import { getClientDocument } from "../../config/client-store.js";

export async function portalGetAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = (req as any).portalSlug as string;

  try {
    const doc = await getClientDocument(slug);
    if (!doc) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Return only client-safe fields
    res.json({
      name: doc.name,
      shadow_mode: doc.shadow_mode ?? false,
      dispatch_text_numbers: doc.dispatch_text_numbers,
      dispatch_call_number: doc.dispatch_call_number,
      dispatch_email: doc.dispatch_email,
      dispatch_cc: doc.dispatch_cc,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
}
