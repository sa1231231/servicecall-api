import { getDb } from "./db.js";
import { getAllClientDocuments } from "../config/client-store.js";
import { ownerConfig } from "../config/notification-clients.js";
import { sendEmail } from "./notify-email.js";
import { sendSmsToAll } from "./notify-sms.js";
const ONE_HOUR_MS = 3_600_000;
const ONE_WEEK_MS = 7 * 24 * ONE_HOUR_MS;
function formatDate(d) {
    return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "America/New_York",
    });
}
async function getCallCountsForClient(clientSlug, start, end, messageTypes) {
    const docs = await getDb()
        .collection("call_logs")
        .find({
        client_slug: clientSlug,
        created_at: { $gte: start, $lt: end },
    })
        .toArray();
    const byKey = {};
    for (const doc of docs) {
        const key = doc.message_type_key || "other";
        byKey[key] = (byKey[key] ?? 0) + 1;
    }
    // Resolve keys to canonical labels from the client config
    const byType = {};
    for (const [key, count] of Object.entries(byKey)) {
        const label = messageTypes[key]?.label ?? "Other";
        byType[label] = (byType[label] ?? 0) + count;
    }
    return { total: docs.length, byType };
}
function buildEmailHtml(clientName, startDate, endDate, counts) {
    const typeLines = Object.entries(counts.byType)
        .sort(([, a], [, b]) => b - a)
        .map(([name, count]) => `<tr><td style="padding:4px 8px;">${name}</td><td style="padding:4px 8px;">${count}</td></tr>`)
        .join("\n");
    return `
<div style="font-family: -apple-system, sans-serif; max-width: 500px;">
  <h2 style="margin:0 0 4px;">Weekly Report &mdash; ${clientName}</h2>
  <p style="color:#666; margin:0 0 16px;">Week of ${startDate} - ${endDate}</p>

  <p style="font-size:18px; font-weight:bold;">Total calls: ${counts.total}</p>

  ${typeLines ? `<table style="border-collapse:collapse; width:100%; margin:8px 0;">${typeLines}</table>` : ""}

  <p style="color:#888; font-size:12px; margin-top:24px;">
    &mdash; Service Call Saver<br/>
    servicecallsaver.com
  </p>
</div>`.trim();
}
function buildEmailText(clientName, startDate, endDate, counts) {
    const typeLines = Object.entries(counts.byType)
        .sort(([, a], [, b]) => b - a)
        .map(([name, count]) => `${name}: ${count}`)
        .join("\n");
    return [
        `Weekly Report — ${clientName}`,
        `Week of ${startDate} - ${endDate}`,
        ``,
        `Total calls: ${counts.total}`,
        ``,
        typeLines,
        ``,
        `— Service Call Saver`,
        `servicecallsaver.com`,
    ]
        .filter((line) => line !== undefined)
        .join("\n");
}
function buildSmsText(clientName, startDate, endDate, counts) {
    const typeLines = Object.entries(counts.byType)
        .sort(([, a], [, b]) => b - a)
        .map(([name, count]) => `${name}: ${count}`)
        .join("\n");
    return [
        `Weekly Report — ${clientName}`,
        `${startDate} - ${endDate}`,
        ``,
        `Total calls: ${counts.total}`,
        typeLines,
        ``,
        `— Service Call Saver`,
    ]
        .filter((line) => line !== undefined)
        .join("\n");
}
async function getLastReportSent(clientSlug) {
    const doc = await getDb()
        .collection("weekly_reports")
        .findOne({ _id: clientSlug });
    return doc ? doc.last_report_sent : null;
}
async function setLastReportSent(clientSlug, date) {
    await getDb()
        .collection("weekly_reports")
        .replaceOne({ _id: clientSlug }, { _id: clientSlug, last_report_sent: date }, { upsert: true });
}
export async function sendWeeklyReportForClient(doc) {
    const slug = doc._id;
    const clientName = doc.name;
    const shadowMode = doc.shadow_mode ?? true;
    const end = new Date();
    const start = new Date(end.getTime() - ONE_WEEK_MS);
    const startDate = formatDate(start);
    const endDate = formatDate(end);
    const counts = await getCallCountsForClient(slug, start, end, doc.message_types ?? {});
    const subject = `Weekly Report — ${clientName}`;
    const emailHtml = buildEmailHtml(clientName, startDate, endDate, counts);
    const emailText = buildEmailText(clientName, startDate, endDate, counts);
    const smsText = buildSmsText(clientName, startDate, endDate, counts);
    // Determine recipients based on shadow_mode
    const emailRecipients = shadowMode
        ? [ownerConfig.email]
        : (doc.dispatch_email ?? []);
    const smsRecipients = shadowMode
        ? [ownerConfig.phone]
        : (doc.dispatch_text_numbers ?? []);
    // Send emails
    for (const to of emailRecipients) {
        try {
            await sendEmail({ to, subject, body: emailText, html: emailHtml });
        }
        catch (err) {
            console.error(`[weekly-report] email failed for "${slug}" to ${to}:`, err.message);
        }
    }
    // Send SMS
    if (smsRecipients.length > 0) {
        try {
            await sendSmsToAll(smsRecipients, smsText);
        }
        catch (err) {
            console.error(`[weekly-report] sms failed for "${slug}":`, err.message);
        }
    }
    await setLastReportSent(slug, end);
    console.log(`[weekly-report] sent for "${clientName}" (shadow=${shadowMode}) | total=${counts.total}`);
}
export async function runWeeklyReports(clientId) {
    const sent = [];
    const skipped = [];
    const errors = [];
    const docs = clientId
        ? await getDb()
            .collection("clients")
            .find({ _id: clientId })
            .toArray()
        : await getAllClientDocuments();
    for (const doc of docs) {
        const slug = doc._id;
        if (!doc.agent_id) {
            skipped.push(slug);
            continue;
        }
        try {
            await sendWeeklyReportForClient(doc);
            sent.push(slug);
        }
        catch (err) {
            console.error(`[weekly-report] error for "${slug}":`, err.message);
            errors.push(slug);
        }
    }
    console.log(`[weekly-report] run complete: ${sent.length} sent, ${skipped.length} skipped, ${errors.length} errors`);
    return { sent, skipped, errors };
}
function isMonday12pmEastern() {
    const now = new Date();
    const eastern = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    return eastern.getDay() === 1 && eastern.getHours() === 12;
}
async function scheduledCheck() {
    if (!isMonday12pmEastern())
        return;
    console.log("[weekly-report] Monday 12-1 PM ET — starting scheduled reports");
    const docs = await getAllClientDocuments();
    for (const doc of docs) {
        const slug = doc._id;
        if (!doc.agent_id)
            continue;
        if (doc.weekly_report_enabled === false) {
            console.log(`[weekly-report] skipping "${slug}" (weekly reports disabled)`);
            continue;
        }
        // Dedupe: skip if already sent within the last 6 days
        const lastSent = await getLastReportSent(slug);
        if (lastSent) {
            const age = Date.now() - new Date(lastSent).getTime();
            if (age < 6 * 24 * ONE_HOUR_MS) {
                console.log(`[weekly-report] skipping "${slug}" (sent ${Math.round(age / ONE_HOUR_MS)}h ago)`);
                continue;
            }
        }
        try {
            await sendWeeklyReportForClient(doc);
        }
        catch (err) {
            console.error(`[weekly-report] scheduled error for "${slug}":`, err.message);
        }
    }
}
export function startWeeklyReportScheduler() {
    console.log("[weekly-report] scheduled hourly check (sends Monday 12-1 PM ET)");
    setInterval(scheduledCheck, ONE_HOUR_MS);
}
