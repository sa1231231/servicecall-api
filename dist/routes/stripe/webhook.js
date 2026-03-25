import Stripe from "stripe";
import { config } from "../../config.js";
import { verifyStripeEventOr400 } from "../../lib/verify-stripe.js";
import { calculateCreditsCentsFromInvoice } from "../../lib/utils.js";
const stripe = new Stripe(config.STRIPE_API_KEY);
export async function webhookHandler(req, res) {
    console.log("stripe-webhook: received request");
    const sig = req.headers["stripe-signature"] ?? "";
    const rawBody = req.body;
    // 1) Verify Stripe signature
    const verified = await verifyStripeEventOr400({
        stripe,
        rawBody,
        sig,
        signingSecret: config.STRIPE_SIGNING_SECRET,
    });
    if (!verified.ok) {
        console.error("stripe-webhook: invalid Stripe signature", {
            error: verified.error,
        });
        res.status(400).json({
            ok: false,
            outcome: "invalid_stripe_signature",
            message: "Invalid Stripe signature.",
            error: verified.error,
        });
        return;
    }
    const event = verified.event;
    console.log("stripe-webhook: event parsed", {
        stripe_event_id: event?.id ?? null,
        stripe_event_type: event?.type ?? null,
    });
    // 2) Only handle invoice.payment_succeeded
    if (event.type !== "invoice.payment_succeeded") {
        console.log("stripe-webhook: ignored event type", { type: event.type });
        res.status(200).json({
            ok: true,
            outcome: "ignored_event",
            message: "Event type ignored (phase 1).",
            stripe_event_type: event.type,
        });
        return;
    }
    const invoice = event.data?.object;
    const invoiceId = invoice?.id ?? null;
    const stripeCustomerId = invoice?.customer ?? null;
    if (!invoice || !invoiceId || !stripeCustomerId) {
        console.error("stripe-webhook: missing invoice fields", {
            stripe_event_id: event?.id ?? null,
            invoice_id: invoiceId,
            stripe_customer_id: stripeCustomerId,
        });
        res.status(400).json({
            ok: false,
            outcome: "invalid_invoice_payload",
            message: "Missing required invoice fields (id/customer).",
            stripe_event_id: event?.id ?? null,
            invoice_id: invoiceId,
            stripe_customer_id: stripeCustomerId,
        });
        return;
    }
    const addCents = calculateCreditsCentsFromInvoice(invoice);
    console.log("stripe-webhook: invoice parsed", {
        stripe_event_id: event?.id ?? null,
        invoice_id: invoiceId,
        stripe_customer_id: stripeCustomerId,
        invoice_amount_paid: invoice?.amount_paid ?? null,
        credits_to_add_cents: addCents,
    });
    if (addCents <= 0) {
        console.error("stripe-webhook: amount_paid missing/<=0; aborting credit", {
            invoice_id: invoiceId,
            stripe_customer_id: stripeCustomerId,
            amount_paid: invoice?.amount_paid ?? null,
        });
        res.status(400).json({
            ok: false,
            outcome: "invalid_amount_paid",
            message: "Invoice payment_succeeded received but amount_paid was missing or <= 0. Credits not added.",
            stripe_event_id: event?.id ?? null,
            invoice_id: invoiceId,
            stripe_customer_id: stripeCustomerId,
            amount_paid: invoice?.amount_paid ?? null,
        });
        return;
    }
    // TODO: Look up business by stripe_customer_id
    // TODO: Idempotency check via last_paid_invoice_id
    // TODO: Update business credit balance
    console.log("stripe-webhook: invoice validated", {
        invoice_id: invoiceId,
        stripe_customer_id: stripeCustomerId,
        credits_to_add_cents: addCents,
    });
    res.status(200).json({
        ok: true,
        outcome: "processed",
        message: "Invoice payment succeeded. Webhook verified and parsed.",
        stripe_event_id: event?.id ?? null,
        stripe_event_type: event?.type ?? null,
        invoice_id: invoiceId,
        stripe_customer_id: stripeCustomerId,
        credits_to_add_cents: addCents,
    });
}
