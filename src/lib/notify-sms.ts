import Twilio from "twilio";
import { config } from "../config.js";

const client = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

export async function sendSms(to: string, message: string) {
  const result = await client.messages.create({
    to,
    from: config.TWILIO_PHONE_NUMBER,
    body: message,
  });
  console.log(`notify-sms: sent to ${to}, sid=${result.sid}`);
  return result;
}

export async function sendSmsToAll(numbers: string[], message: string) {
  const results = await Promise.allSettled(
    numbers.map((num) => sendSms(num, message)),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`notify-sms: failed to send to ${numbers[i]}`, result.reason);
    }
  }

  return results;
}
