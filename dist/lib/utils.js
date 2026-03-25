// ─────────────────────────────────────────────────────────────
// TIME
// ─────────────────────────────────────────────────────────────
export function msToIso(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms))
        return null;
    return new Date(ms).toISOString();
}
// ─────────────────────────────────────────────────────────────
// MONEY / NUMBER UTILS
// ─────────────────────────────────────────────────────────────
export function roundUpToTenthCent(value) {
    return Math.ceil(value * 10) / 10;
}
export function roundTo1Decimal(value) {
    return Number(value.toFixed(1));
}
export function calculateCreditsCentsFromInvoice(invoice) {
    const amountPaid = invoice?.amount_paid;
    if (typeof amountPaid === "number" && Number.isFinite(amountPaid)) {
        return Math.trunc(amountPaid);
    }
    if (typeof amountPaid === "string") {
        const n = Number(amountPaid);
        return Number.isFinite(n) ? Math.trunc(n) : 0;
    }
    return 0;
}
