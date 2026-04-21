import Twilio from "twilio";
import { config } from "../config.js";
import { withRetry } from "./retry.js";
const twilioClient = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
export async function sendSms(to, message) {
    return withRetry(async () => {
        const result = await twilioClient.messages.create({
            to,
            from: config.TWILIO_PHONE_NUMBER,
            body: message,
        });
        console.log(`notify-sms: sent to ${to}, sid=${result.sid}`);
        return result;
    }, { label: `sms to ${to}` });
}
export async function sendSmsToAll(numbers, message) {
    const results = await Promise.allSettled(numbers.map((num) => sendSms(num, message)));
    const failures = [];
    for (const [i, result] of results.entries()) {
        if (result.status === "rejected") {
            const msg = result.reason?.message ?? String(result.reason);
            console.error(`notify-sms: failed to send to ${numbers[i]}`, result.reason);
            failures.push(`SMS to ${numbers[i]}: ${msg}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(failures.join("; "));
    }
    return results;
}
