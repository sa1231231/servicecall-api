import Retell from "retell-sdk";
export function verifyRetellWebhookOrThrow(rawBody, signature, signatureKey) {
    if (!signature)
        throw new Error("Missing x-retell-signature header");
    if (!signatureKey)
        throw new Error("Missing RETELL_SIGNATURE_KEY");
    const ok = Retell.verify(rawBody, signatureKey, signature);
    if (!ok)
        throw new Error("Invalid Retell signature");
}
export function verifyRetellWebhookOr401(rawBody, signature, signatureKey, res) {
    try {
        verifyRetellWebhookOrThrow(rawBody, signature, signatureKey);
        return true;
    }
    catch (err) {
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
