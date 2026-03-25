export async function verifyStripeEventOr400(args) {
    try {
        const event = args.stripe.webhooks.constructEvent(args.rawBody, args.sig, args.signingSecret);
        return { ok: true, event };
    }
    catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
