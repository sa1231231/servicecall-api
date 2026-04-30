import { notificationClients } from "../_cache/clients.js";
import { sendSms } from "./notify-sms.js";

export interface BlastRecipient {
  number: string;
  clientName: string;
}

export interface BlastResult {
  total_recipients: number;
  total_clients: number;
  sent: number;
  failed: Array<{ number: string; error: string }>;
}

export interface BlastPreview {
  total_recipients: number;
  total_clients: number;
  sample_message: string;
}

const DELAY_MS = 1000; // 1 second between messages

/** Gather all eligible recipients (active, non-shadow clients). */
export function gatherRecipients(): { recipients: BlastRecipient[]; clientCount: number } {
  const recipients: BlastRecipient[] = [];
  let clientCount = 0;

  for (const client of Object.values(notificationClients)) {
    if (client.shadow_mode === true) continue;
    if (client.active === false) continue;
    if (!client.dispatch_text_numbers || client.dispatch_text_numbers.length === 0) continue;

    clientCount++;
    for (const number of client.dispatch_text_numbers) {
      recipients.push({ number, clientName: client.name });
    }
  }

  return { recipients, clientCount };
}

/** Replace {{client_name}} in the message template. */
export function personalizeMessage(template: string, clientName: string): string {
  return template.replace(/\{\{client_name\}\}/gi, clientName);
}

/** Preview the blast without sending. */
export function previewBlast(message: string): BlastPreview {
  const { recipients, clientCount } = gatherRecipients();
  const sampleName = recipients.length > 0 ? recipients[0].clientName : "Acme Co";

  return {
    total_recipients: recipients.length,
    total_clients: clientCount,
    sample_message: personalizeMessage(message, sampleName),
  };
}

/** Send an SMS blast with 1-second delay between each message. */
export async function sendBlast(message: string): Promise<BlastResult> {
  const { recipients, clientCount } = gatherRecipients();

  const result: BlastResult = {
    total_recipients: recipients.length,
    total_clients: clientCount,
    sent: 0,
    failed: [],
  };

  for (let i = 0; i < recipients.length; i++) {
    const { number, clientName } = recipients[i];
    const personalizedMsg = personalizeMessage(message, clientName);

    try {
      await sendSms(number, personalizedMsg);
      result.sent++;
      console.log(`[blast-sms] sent ${i + 1}/${recipients.length} to ${number}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[blast-sms] failed ${number}: ${msg}`);
      result.failed.push({ number, error: msg });
    }

    // Delay between sends (skip after last)
    if (i < recipients.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`[blast-sms] complete: ${result.sent} sent, ${result.failed.length} failed out of ${result.total_recipients}`);
  return result;
}
