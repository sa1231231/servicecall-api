import { describe, it, expect, vi } from "vitest";
import { verifyStripeEventOr400 } from "../verify-stripe.js";
function makeStripe(impl) {
    return {
        webhooks: {
            constructEvent: vi.fn(impl),
        },
    };
}
describe("verifyStripeEventOr400", () => {
    it("returns ok=true with the constructed event on valid signature", async () => {
        const event = { id: "evt_123", type: "invoice.paid" };
        const stripe = makeStripe(() => event);
        const result = await verifyStripeEventOr400({
            stripe,
            rawBody: '{"foo":"bar"}',
            sig: "valid-sig",
            signingSecret: "whsec_test",
        });
        expect(result).toEqual({ ok: true, event });
        expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith('{"foo":"bar"}', "valid-sig", "whsec_test");
    });
    it("returns ok=false with the error message on invalid signature", async () => {
        const stripe = makeStripe(() => {
            throw new Error("No signatures found");
        });
        const result = await verifyStripeEventOr400({
            stripe,
            rawBody: "{}",
            sig: "bad-sig",
            signingSecret: "whsec_test",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toBe("No signatures found");
        }
    });
    it("stringifies non-Error throw values", async () => {
        const stripe = makeStripe(() => {
            throw "string error";
        });
        const result = await verifyStripeEventOr400({
            stripe,
            rawBody: "{}",
            sig: "bad",
            signingSecret: "whsec_test",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toBe("string error");
        }
    });
    it("accepts Buffer rawBody", async () => {
        const event = { id: "evt_buf", type: "test" };
        const stripe = makeStripe(() => event);
        const buf = Buffer.from('{"x":1}');
        const result = await verifyStripeEventOr400({
            stripe,
            rawBody: buf,
            sig: "sig",
            signingSecret: "whsec",
        });
        expect(result).toEqual({ ok: true, event });
        expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(buf, "sig", "whsec");
    });
});
