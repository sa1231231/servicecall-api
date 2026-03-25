import Stripe from "stripe";
export declare function verifyStripeEventOr400(args: {
    stripe: Stripe;
    rawBody: string | Buffer;
    sig: string;
    signingSecret: string;
}): Promise<{
    ok: true;
    event: Stripe.Event;
} | {
    ok: false;
    error: string;
}>;
