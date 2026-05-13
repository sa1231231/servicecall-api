import { getDb } from "./db.js";

export interface OutboundMessageDocument {
  call_id: string | null;
  client_slug: string;
  client_name: string;
  agent_id: string | null;
  to: string;
  from: string;
  body: string;
  twilio_sid: string | null;
  twilio_status: string | null;
  source: "retell_tool" | "mcp";
  error: string | null;
  created_at: Date;
}

function outboundMessages() {
  return getDb().collection<OutboundMessageDocument>("outbound_messages");
}

export async function saveOutboundMessage(
  doc: OutboundMessageDocument,
): Promise<void> {
  try {
    await outboundMessages().insertOne(doc);
    console.log(
      `[outbound-messages] saved ${doc.from} → ${doc.to} (${doc.client_slug}, sid=${doc.twilio_sid ?? "none"})`,
    );
  } catch (err: any) {
    console.error(
      `[outbound-messages] failed to save ${doc.from} → ${doc.to}:`,
      err.message,
    );
  }
}
