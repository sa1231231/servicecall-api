import type { Request, Response } from "express";
import { getClientDocument, updateClientField } from "../../config/client-store.js";
import { provisionPhoneNumber } from "../../lib/provision-number.js";

export async function provisionNumberHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { slug } = req.body as { slug?: string };

  if (!slug) {
    res.status(400).json({ error: "Missing required field: slug" });
    return;
  }

  const doc = await getClientDocument(slug);
  if (!doc) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }

  const agentId = doc.agent_ids?.[0];
  if (!agentId) {
    res.status(400).json({ error: `Client "${slug}" has no agent_ids` });
    return;
  }

  // Derive area code: client-level dispatch call > per-path override > default (815)
  const dispatchCallNumber = doc.dispatch_call_number
    || (doc.dispatch_by_type
      ? Object.values(doc.dispatch_by_type as Record<string, any>).find((o: any) => o.dispatch_call_number)?.dispatch_call_number
      : null)
    || undefined;

  try {
    const result = await provisionPhoneNumber({
      agentId,
      clientName: doc.name,
      dispatchCallNumber,
    });

    await updateClientField(slug, "outbound_from_number", result.phoneNumber);

    res.json({
      success: true,
      phone_number: result.phoneNumber,
      phone_number_sid: result.phoneNumberSid,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[provision-number] error for "${slug}":`, message);
    res.status(502).json({ error: "Phone number provisioning failed", details: message });
  }
}
