import { getDb } from "./db.js";
import { getSettings } from "./settings.js";
import { getNumberDaysInRange } from "./phone-number-history.js";
/** Start of a UTC month (inclusive). */
function monthStart(year, month) {
    return new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
}
/** Start of the next UTC month (exclusive end). */
function monthEnd(year, month) {
    return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
}
function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
function ymKey(year, month) {
    return `${year.toString().padStart(4, "0")}-${(month + 1).toString().padStart(2, "0")}`;
}
async function aggregateCallLogsForMonth(client_slug, year, month) {
    const start = monthStart(year, month);
    const end = monthEnd(year, month);
    const result = await getDb()
        .collection("call_logs")
        .aggregate([
        { $match: { client_slug, created_at: { $gte: start, $lt: end } } },
        {
            $group: {
                _id: null,
                retell_cents: { $sum: { $ifNull: ["$call_cost_cents", 0] } },
                sms_count: { $sum: { $ifNull: ["$sms_count", 0] } },
                email_count: { $sum: { $ifNull: ["$email_count", 0] } },
            },
        },
    ])
        .toArray();
    if (result.length === 0)
        return { retell_cents: 0, sms_count: 0, email_count: 0 };
    return {
        retell_cents: result[0].retell_cents ?? 0,
        sms_count: result[0].sms_count ?? 0,
        email_count: result[0].email_count ?? 0,
    };
}
async function bucketForMonth(client_slug, year, month, rates, isCurrent) {
    const start = monthStart(year, month);
    // For current month, only count days up to "now" so phone rental doesn't pre-bill the whole month.
    const end = isCurrent ? new Date() : monthEnd(year, month);
    const calls = await aggregateCallLogsForMonth(client_slug, year, month);
    const phoneDays = await getNumberDaysInRange(client_slug, start, end);
    const dailyRate = rates.twilio_number_monthly_cents / daysInMonth(year, month);
    const sms_cents = Math.round(calls.sms_count * rates.twilio_sms_cents);
    const email_cents = Math.round(calls.email_count * rates.resend_email_cents);
    const phone_cents = Math.round(phoneDays * dailyRate);
    return {
        month: ymKey(year, month),
        is_partial: isCurrent,
        retell_cents: calls.retell_cents,
        sms_count: calls.sms_count,
        sms_cents,
        email_count: calls.email_count,
        email_cents,
        phone_number_days: Math.round(phoneDays * 100) / 100,
        phone_cents,
        total_cents: calls.retell_cents + sms_cents + email_cents + phone_cents,
    };
}
/** Full COGS breakdown for one client: current MTD + the last `monthsBack` complete months. */
export async function getClientCogs(client_slug, monthsBack = 6) {
    const settings = await getSettings();
    const rates = settings.cost_rates;
    const now = new Date();
    const curYear = now.getUTCFullYear();
    const curMonth = now.getUTCMonth();
    const current = await bucketForMonth(client_slug, curYear, curMonth, rates, true);
    const history = [];
    for (let i = 1; i <= monthsBack; i++) {
        let y = curYear;
        let m = curMonth - i;
        while (m < 0) {
            m += 12;
            y -= 1;
        }
        history.push(await bucketForMonth(client_slug, y, m, rates, false));
    }
    return { client_slug, rates, current, history };
}
/** Lightweight: MTD total cents per client, for the agent-list column. */
export async function getMtdCogsForAllClients() {
    const settings = await getSettings();
    const rates = settings.cost_rates;
    const now = new Date();
    const curYear = now.getUTCFullYear();
    const curMonth = now.getUTCMonth();
    const start = monthStart(curYear, curMonth);
    // One aggregation across all clients for this month's call costs.
    const callRows = await getDb()
        .collection("call_logs")
        .aggregate([
        { $match: { created_at: { $gte: start, $lt: now } } },
        {
            $group: {
                _id: "$client_slug",
                retell_cents: { $sum: { $ifNull: ["$call_cost_cents", 0] } },
                sms_count: { $sum: { $ifNull: ["$sms_count", 0] } },
                email_count: { $sum: { $ifNull: ["$email_count", 0] } },
            },
        },
    ])
        .toArray();
    const dailyRate = rates.twilio_number_monthly_cents / daysInMonth(curYear, curMonth);
    // Pull per-client number-days from phone_number_history. One read across all clients.
    const phoneEvents = await getDb()
        .collection("phone_number_history")
        .find({})
        .sort({ client_slug: 1, phone_number: 1, at: 1 })
        .toArray();
    const phoneDaysBySlug = new Map();
    // Group events by (client_slug, phone_number) and walk each timeline.
    const grouped = new Map();
    for (const ev of phoneEvents) {
        const key = `${ev.client_slug}|${ev.phone_number}`;
        if (!grouped.has(key))
            grouped.set(key, []);
        grouped.get(key).push(ev);
    }
    const MS_PER_DAY = 86_400_000;
    for (const [key, events] of grouped) {
        const slug = key.split("|", 1)[0];
        let activeSince = null;
        let days = 0;
        for (const ev of events) {
            if (ev.event === "provisioned" && activeSince === null) {
                activeSince = ev.at;
            }
            else if (ev.event === "released" && activeSince !== null) {
                days += overlap(activeSince, ev.at, start, now) / MS_PER_DAY;
                activeSince = null;
            }
        }
        if (activeSince !== null) {
            days += overlap(activeSince, now, start, now) / MS_PER_DAY;
        }
        phoneDaysBySlug.set(slug, (phoneDaysBySlug.get(slug) ?? 0) + days);
    }
    const out = {};
    // Start with all slugs that have either calls or phone events this month.
    const slugs = new Set([
        ...callRows.map((r) => r._id),
        ...phoneDaysBySlug.keys(),
    ]);
    for (const slug of slugs) {
        const row = callRows.find((r) => r._id === slug);
        const retell = row?.retell_cents ?? 0;
        const smsCount = row?.sms_count ?? 0;
        const emailCount = row?.email_count ?? 0;
        const phoneDays = phoneDaysBySlug.get(slug) ?? 0;
        const total = retell +
            Math.round(smsCount * rates.twilio_sms_cents) +
            Math.round(emailCount * rates.resend_email_cents) +
            Math.round(phoneDays * dailyRate);
        out[slug] = total;
    }
    return out;
}
function overlap(a1, a2, b1, b2) {
    const start = Math.max(a1.getTime(), b1.getTime());
    const end = Math.min(a2.getTime(), b2.getTime());
    return Math.max(0, end - start);
}
