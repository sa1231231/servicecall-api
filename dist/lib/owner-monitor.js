import Retell from "retell-sdk";
import { config } from "../config.js";
import { ownerConfig } from "../config/notification-clients.js";
import { sendEmail } from "./notify-email.js";
import { sendSms } from "./notify-sms.js";
import { escapeHtml } from "./escape-html.js";
import { enrichCallLog } from "./call-log.js";
const retell = new Retell({ apiKey: config.RETELL_API_KEY });
const ANALYSIS_FETCH_DELAY_MS = 5_000;
function formatDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, "0")}`;
}
function isProblemCall(analysis, disconnectionReason) {
    if (analysis.user_sentiment === "Negative")
        return true;
    if (analysis.call_successful === false)
        return true;
    if (analysis.in_voicemail === true)
        return true;
    if (disconnectionReason.startsWith("error_"))
        return true;
    return false;
}
export async function sendOwnerCallMonitor(call, clientConfig, notificationOutcome) {
    // Skip test clients
    if (clientConfig.name.includes("Test"))
        return;
    const callId = call.call_id ?? "unknown";
    const fromNumber = call.from_number ?? "unknown";
    const disconnectionReason = call.disconnection_reason ?? "unknown";
    // Wait for Retell to compute call analysis, then fetch enriched call data
    await new Promise((r) => setTimeout(r, ANALYSIS_FETCH_DELAY_MS));
    let enrichedCall = call;
    try {
        if (callId !== "unknown") {
            enrichedCall = await retell.call.retrieve(callId);
            console.log(`owner-monitor: fetched enriched call data for ${callId}`);
        }
    }
    catch (err) {
        console.warn(`owner-monitor: failed to fetch call ${callId}, using webhook data: ${err.message}`);
    }
    const durationMs = enrichedCall.duration_ms ?? call.duration_ms ?? 0;
    const duration = formatDuration(durationMs);
    const transcript = enrichedCall.transcript ?? call.transcript ?? "(no transcript)";
    const recordingUrl = enrichedCall.recording_url ?? call.recording_url ?? null;
    const publicLogUrl = enrichedCall.public_log_url ?? call.public_log_url ?? null;
    const analysis = enrichedCall.call_analysis ?? call.call_analysis ?? {};
    const sentiment = analysis.user_sentiment ?? "Unknown";
    const callSuccessful = analysis.call_successful;
    const callSummary = analysis.call_summary ?? "(no summary)";
    const inVoicemail = analysis.in_voicemail ?? false;
    const problem = isProblemCall(analysis, disconnectionReason);
    // Enrich call log in MongoDB with analysis data
    if (callId !== "unknown") {
        enrichCallLog(callId, {
            call_summary: analysis.call_summary,
            user_sentiment: sentiment,
            call_successful: callSuccessful,
            in_voicemail: inVoicemail,
            recording_url: recordingUrl ?? undefined,
            public_log_url: publicLogUrl ?? undefined,
            transcript: transcript !== "(no transcript)" ? transcript : undefined,
        }).catch(() => { });
    }
    // Build subject
    const subjectPrefix = problem ? "[ALERT]" : "[Monitor]";
    const subjectParts = [subjectPrefix, clientConfig.name, `—`, duration, `—`, sentiment];
    if (problem && disconnectionReason.startsWith("error_")) {
        subjectParts.push(`—`, disconnectionReason);
    }
    const subject = subjectParts.join(" ");
    // Build HTML email
    const statusColor = problem ? "#d32f2f" : "#2e7d32";
    const statusLabel = problem ? "PROBLEM" : "OK";
    const successText = callSuccessful === true ? "Yes" : callSuccessful === false ? "No" : "Unknown";
    const linksHtml = [
        recordingUrl ? `<a href="${escapeHtml(recordingUrl)}">Recording</a>` : null,
        publicLogUrl ? `<a href="${escapeHtml(publicLogUrl)}">Retell Logs</a>` : null,
    ]
        .filter(Boolean)
        .join(" &nbsp;|&nbsp; ");
    const html = `
<div style="font-family: -apple-system, sans-serif; max-width: 600px;">
  <p style="background: ${statusColor}; color: white; padding: 8px 12px; border-radius: 4px; display: inline-block; font-weight: bold;">
    ${statusLabel}
  </p>

  <table style="border-collapse: collapse; width: 100%; margin: 12px 0;">
    <tr><td style="padding: 4px 8px; font-weight: bold;">Client</td><td style="padding: 4px 8px;">${escapeHtml(clientConfig.name)}</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Call ID</td><td style="padding: 4px 8px;"><code>${escapeHtml(callId)}</code></td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Caller</td><td style="padding: 4px 8px;">${escapeHtml(fromNumber)}</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Duration</td><td style="padding: 4px 8px;">${escapeHtml(duration)}</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Disconnection</td><td style="padding: 4px 8px;">${escapeHtml(disconnectionReason)}</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Sentiment</td><td style="padding: 4px 8px;">${escapeHtml(sentiment)}</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Call Successful</td><td style="padding: 4px 8px;">${successText}</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Voicemail</td><td style="padding: 4px 8px;">${inVoicemail ? "Yes" : "No"}</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Notification</td><td style="padding: 4px 8px;">${escapeHtml(notificationOutcome)}</td></tr>
  </table>

  ${linksHtml ? `<p>${linksHtml}</p>` : ""}

  <h3 style="margin: 16px 0 4px;">Summary</h3>
  <p style="background: #f5f5f5; padding: 12px; border-radius: 4px;">${escapeHtml(callSummary)}</p>

  <h3 style="margin: 16px 0 4px;">Transcript</h3>
  <pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; white-space: pre-wrap; font-size: 13px;">${escapeHtml(transcript)}</pre>

  <p style="color: #888; font-size: 12px; margin-top: 24px;">— Service Call Saver Monitor</p>
</div>`.trim();
    const plainBody = [
        `${statusLabel} — ${clientConfig.name}`,
        `Call ID: ${callId}`,
        `Caller: ${fromNumber}`,
        `Duration: ${duration}`,
        `Disconnection: ${disconnectionReason}`,
        `Sentiment: ${sentiment}`,
        `Call Successful: ${successText}`,
        `Voicemail: ${inVoicemail ? "Yes" : "No"}`,
        `Notification: ${notificationOutcome}`,
        recordingUrl ? `Recording: ${recordingUrl}` : null,
        publicLogUrl ? `Retell Logs: ${publicLogUrl}` : null,
        ``,
        `--- Summary ---`,
        callSummary,
        ``,
        `--- Transcript ---`,
        transcript,
        ``,
        `— Service Call Saver Monitor`,
    ]
        .filter((line) => line !== null)
        .join("\n");
    // Send monitor email
    await sendEmail({
        to: ownerConfig.email,
        subject,
        body: plainBody,
        html,
    });
    // SMS alert for problem calls only
    if (problem) {
        const smsAlert = [
            `[ALERT] ${clientConfig.name}`,
            `Duration: ${duration}`,
            `Sentiment: ${sentiment}`,
            `Reason: ${disconnectionReason}`,
            callSuccessful === false ? `Call Successful: No` : null,
            inVoicemail ? `Voicemail: Yes` : null,
            ``,
            `Check email for full transcript.`,
        ]
            .filter((line) => line !== null)
            .join("\n");
        await sendSms(ownerConfig.phone, smsAlert);
    }
    console.log(`owner-monitor: sent | client="${clientConfig.name}" | call_id=${callId} | problem=${problem}`);
}
