import type { Request, Response } from "express";
import { getClientDocument } from "../../config/client-store.js";
import { ownerConfig } from "../../config/notification-clients.js";

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

    // Return only client-safe fields, strip owner phone/email
    const textNumbers = (doc.dispatch_text_numbers || []).filter((n) => n !== ownerConfig.phone);
    const emails = (doc.dispatch_email || []).filter((e) => e !== ownerConfig.email);
    const callNumber = doc.dispatch_call_number === ownerConfig.phone ? null : doc.dispatch_call_number;
    const cc = doc.dispatch_cc === ownerConfig.email ? null : doc.dispatch_cc;

    // Per-path dispatch overrides (only include paths that have overrides)
    const dbt = doc.dispatch_by_type || {};
    const filteredDbt: Record<string, any> = {};
    for (const [key, override] of Object.entries(dbt)) {
      const o: any = {};
      if (override.dispatch_text_numbers?.length) {
        o.dispatch_text_numbers = override.dispatch_text_numbers.filter((n: string) => n !== ownerConfig.phone);
      }
      if (override.dispatch_email?.length) {
        o.dispatch_email = override.dispatch_email.filter((e: string) => e !== ownerConfig.email);
      }
      if (override.dispatch_call_number && override.dispatch_call_number !== ownerConfig.phone) {
        o.dispatch_call_number = override.dispatch_call_number;
      }
      if (Object.keys(o).length > 0) {
        filteredDbt[key] = o;
      }
    }

    // Path labels from message_types
    const pathLabels: Record<string, string> = {};
    const mt = doc.message_types || {};
    for (const [key, val] of Object.entries(mt)) {
      pathLabels[key] = (val as any).label || key;
    }

    const response: any = {
      name: doc.name,
      shadow_mode: doc.shadow_mode ?? false,
      dispatch_text_numbers: textNumbers,
      dispatch_call_number: callNumber,
      dispatch_email: emails.length > 0 ? emails : null,
      dispatch_cc: cc,
    };

    // Only include overrides if any exist
    if (Object.keys(filteredDbt).length > 0) {
      response.dispatch_by_type = filteredDbt;
      response.path_labels = pathLabels;
    }

    res.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
}
