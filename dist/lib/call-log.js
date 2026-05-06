import { getDb } from "./db.js";
function callLogs() {
    return getDb().collection("call_logs");
}
/** Save a call log document (fire-and-forget safe). */
export async function saveCallLog(doc) {
    try {
        await callLogs().replaceOne({ _id: doc._id }, doc, { upsert: true });
        console.log(`[call-log] saved call ${doc._id} for "${doc.client_name}"`);
    }
    catch (err) {
        console.error(`[call-log] failed to save call ${doc._id}:`, err.message);
    }
}
/** Enrich a call log with analysis data from Retell (called by owner-monitor). */
export async function enrichCallLog(callId, data) {
    try {
        const update = {};
        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined && value !== null) {
                update[key] = value;
            }
        }
        if (Object.keys(update).length === 0)
            return;
        await callLogs().updateOne({ _id: callId }, { $set: update });
        console.log(`[call-log] enriched call ${callId}`);
    }
    catch (err) {
        console.error(`[call-log] failed to enrich call ${callId}:`, err.message);
    }
}
/** Get a single call log by ID. */
export async function getCallLogById(callId) {
    return callLogs().findOne({ _id: callId });
}
/** Get call logs for a client, sorted newest first. */
export async function getCallLogsByClient(clientSlug, limit = 50, offset = 0, options = {}) {
    const filter = { client_slug: clientSlug };
    if (!options.includeTests)
        filter.test_mode = { $ne: true };
    return callLogs()
        .find(filter)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();
}
