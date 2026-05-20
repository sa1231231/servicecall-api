import type { Request, Response } from "express";
import { getClientDocument, updateClientField } from "../../config/client-store.js";
import { provisionPhoneNumber } from "../../lib/provision-number.js";
import { logPhoneEvent } from "../../lib/phone-number-history.js";

export async function provisionNumberHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { slug, areaCode } = req.body as { slug?: string; areaCode?: number };

  if (!slug) {
    res.status(400).json({ error: "Missing required field: slug" });
    return;
  }

  if (areaCode !== undefined) {
    // US area codes are 3 digits; reject anything else outright so a
    // typo doesn't push the provisioner to a default fallback.
    if (typeof areaCode !== "number" || !Number.isInteger(areaCode) || areaCode < 200 || areaCode > 999) {
      res.status(400).json({ error: `Invalid areaCode "${areaCode}" — must be a 3-digit US area code` });
      return;
    }
  }

  const doc = await getClientDocument(slug);
  if (!doc) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }

  const agentId = doc.agent_id;
  if (!agentId) {
    res.status(400).json({ error: `Client "${slug}" has no agent_id` });
    return;
  }

  // Derive area code: explicit override > client-level dispatch call >
  // per-path override > default (815). Explicit override is for cases
  // like Grit Services where dispatch_call_number is null and the
  // contact's actual locality (e.g. Michigan, 248) isn't derivable from
  // any dispatch field.
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
      areaCode,
    });

    await updateClientField(slug, "outbound_from_number", result.phoneNumber);
    await logPhoneEvent(slug, result.phoneNumber, result.phoneNumberSid, "provisioned");

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
