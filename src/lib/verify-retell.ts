import Retell from "retell-sdk";
import type { Response } from "express";

// Retell SDK's verify() is async (returns a Promise<boolean>). Earlier
// versions of this file called it synchronously, which meant the returned
// Promise was truthy and the `if (!ok)` guard never fired — letting
// forged signatures through. Always await the SDK call.
export async function verifyRetellWebhookOrThrow(
  rawBody: string,
  signature: string,
  signatureKey: string,
) {
  if (!signature) throw new Error("Missing x-retell-signature header");
  if (!signatureKey) throw new Error("Missing RETELL_SIGNATURE_KEY");

  const ok = await Retell.verify(rawBody, signatureKey, signature);
  if (!ok) throw new Error("Invalid Retell signature");
}

export async function verifyRetellWebhookOr401(
  rawBody: string,
  signature: string,
  signatureKey: string,
  res: Response,
): Promise<boolean> {
  try {
    await verifyRetellWebhookOrThrow(rawBody, signature, signatureKey);
    return true;
  } catch (err) {
    console.error("retell: signature verification failed", err);

    const msg = err instanceof Error ? err.message : String(err);
    const outcome = msg.includes("Missing x-retell-signature")
      ? "missing_signature_header"
      : msg.includes("Missing RETELL_SIGNATURE_KEY")
        ? "missing_signature_key"
        : "invalid_signature";

    res.status(401).json({
      ok: false,
      outcome,
      message: "Retell webhook authentication failed.",
    });
    return false;
  }
}
