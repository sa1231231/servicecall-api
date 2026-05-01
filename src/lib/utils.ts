// ─────────────────────────────────────────────────────────────
// MONEY / NUMBER UTILS
// ─────────────────────────────────────────────────────────────

export function calculateCreditsCentsFromInvoice(invoice: any): number {
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
