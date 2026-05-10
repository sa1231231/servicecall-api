import { getDb } from "./db.js";

export interface CallLogDocument {
  _id: string;
  client_slug: string;
  client_name: string;
  agent_id: string;
  from_number: string;
  duration_ms: number;
  disconnection_reason: string;
  all_variables: Record<string, string>;
  extracted_fields: Record<string, string>;
  message_type_key: string;
  message_type_label: string;
  outcome: string;
  shadow_mode: boolean;
  test_mode?: boolean;
  call_summary?: string;
  user_sentiment?: string;
  call_successful?: boolean;
  in_voicemail?: boolean;
  recording_url?: string;
  public_log_url?: string;
  transcript?: string;
  call_cost_cents?: number;
  sms_count?: number;
  email_count?: number;
  created_at: Date;
}

function callLogs() {
  return getDb().collection<CallLogDocument>("call_logs");
}

/** Save a call log document (fire-and-forget safe). */
export async function saveCallLog(doc: CallLogDocument): Promise<void> {
  try {
    await callLogs().replaceOne(
      { _id: doc._id },
      doc,
      { upsert: true },
    );
    console.log(`[call-log] saved call ${doc._id} for "${doc.client_name}"`);
  } catch (err: any) {
    console.error(`[call-log] failed to save call ${doc._id}:`, err.message);
  }
}

/** Enrich a call log with analysis data from Retell (called by owner-monitor). */
export async function enrichCallLog(
  callId: string,
  data: {
    call_summary?: string;
    user_sentiment?: string;
    call_successful?: boolean;
    in_voicemail?: boolean;
    recording_url?: string;
    public_log_url?: string;
    transcript?: string;
  },
): Promise<void> {
  try {
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        update[key] = value;
      }
    }
    if (Object.keys(update).length === 0) return;

    await callLogs().updateOne(
      { _id: callId },
      { $set: update },
    );
    console.log(`[call-log] enriched call ${callId}`);
  } catch (err: any) {
    console.error(`[call-log] failed to enrich call ${callId}:`, err.message);
  }
}

/** Get a single call log by ID. */
export async function getCallLogById(
  callId: string,
): Promise<CallLogDocument | null> {
  return callLogs().findOne({ _id: callId }) as any;
}

/** Ensure indexes for call_logs. Currently powers the finding-rates metric
 *  (groups completed calls per agent per week) and any future per-agent
 *  call browsing. No TTL — call_logs are long-term billing/audit records. */
export async function ensureCallLogIndexes(): Promise<void> {
  await callLogs().createIndex({ agent_id: 1, created_at: -1 });
  await callLogs().createIndex({ client_slug: 1, created_at: -1 });
  console.log("[call-log] indexes ensured");
}

/** Get call logs for a client, sorted newest first. */
export async function getCallLogsByClient(
  clientSlug: string,
  limit = 50,
  offset = 0,
  options: { includeTests?: boolean } = {},
): Promise<CallLogDocument[]> {
  const filter: Record<string, unknown> = { client_slug: clientSlug };
  if (!options.includeTests) filter.test_mode = { $ne: true };
  return callLogs()
    .find(filter)
    .sort({ created_at: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
}
