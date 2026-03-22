import Stripe from "stripe";

export async function verifyStripeEventOr400(args: {
  stripe: Stripe;
  rawBody: string | Buffer;
  sig: string;
  signingSecret: string;
}): Promise<{ ok: true; event: Stripe.Event } | { ok: false; error: string }> {
  try {
    const event = args.stripe.webhooks.constructEvent(
      args.rawBody,
      args.sig,
      args.signingSecret,
    );
    return { ok: true, event };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
