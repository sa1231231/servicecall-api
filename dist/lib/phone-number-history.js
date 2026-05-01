import { getDb } from "./db.js";
function collection() {
    return getDb().collection("phone_number_history");
}
/** Append a provision/release event for a client's phone number. Fire-and-forget safe. */
export async function logPhoneEvent(client_slug, phone_number, phone_number_sid, event, at = new Date()) {
    try {
        await collection().insertOne({ client_slug, phone_number, phone_number_sid, event, at });
        console.log(`[phone-history] logged ${event} for "${client_slug}" (${phone_number})`);
    }
    catch (err) {
        console.error(`[phone-history] failed to log ${event} for "${client_slug}":`, err.message);
    }
}
/**
 * For each phone number that was ever assigned to this client, compute the number of days
 * within [start, end) during which the number was active (provisioned but not yet released).
 * Returns the total number-days summed across all numbers.
 */
export async function getNumberDaysInRange(client_slug, start, end) {
    const events = await collection()
        .find({ client_slug })
        .sort({ phone_number: 1, at: 1 })
        .toArray();
    if (events.length === 0)
        return 0;
    // Group events by phone number, then walk each number's timeline computing active windows.
    const byNumber = new Map();
    for (const ev of events) {
        if (!byNumber.has(ev.phone_number))
            byNumber.set(ev.phone_number, []);
        byNumber.get(ev.phone_number).push(ev);
    }
    const MS_PER_DAY = 86_400_000;
    let totalDays = 0;
    for (const [, numEvents] of byNumber) {
        let activeSince = null;
        for (const ev of numEvents) {
            if (ev.event === "provisioned" && activeSince === null) {
                activeSince = ev.at;
            }
            else if (ev.event === "released" && activeSince !== null) {
                const overlapMs = overlap(activeSince, ev.at, start, end);
                totalDays += overlapMs / MS_PER_DAY;
                activeSince = null;
            }
        }
        // Still active at the end of the timeline → overlap up to `end`.
        if (activeSince !== null) {
            const overlapMs = overlap(activeSince, end, start, end);
            totalDays += overlapMs / MS_PER_DAY;
        }
    }
    return totalDays;
}
/** Milliseconds of overlap between [a1, a2) and [b1, b2). */
function overlap(a1, a2, b1, b2) {
    const start = Math.max(a1.getTime(), b1.getTime());
    const end = Math.min(a2.getTime(), b2.getTime());
    return Math.max(0, end - start);
}
/**
 * One-time backfill: for each client with a currently-assigned outbound_from_number that
 * has no provisioning event recorded, emit a synthetic `provisioned` event dated today.
 * Safe to re-run — checks for an existing event before writing. Returns the number of
 * synthetic events written.
 */
export async function backfillCurrentPhoneNumbers(clients, at = new Date()) {
    let written = 0;
    for (const c of clients) {
        if (!c.phone_number)
            continue;
        const existing = await collection().findOne({
            client_slug: c.client_slug,
            phone_number: c.phone_number,
            event: "provisioned",
        });
        if (existing)
            continue;
        await collection().insertOne({
            client_slug: c.client_slug,
            phone_number: c.phone_number,
            phone_number_sid: c.phone_number_sid ?? "",
            event: "provisioned",
            at,
        });
        written++;
    }
    if (written > 0)
        console.log(`[phone-history] backfilled ${written} provisioning event(s)`);
    return written;
}
