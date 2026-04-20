import { ownerConfig, type ClientNotificationConfig } from "../config/notification-clients.js";
import { sendEmail } from "./notify-email.js";
import { sendSms } from "./notify-sms.js";
import { escapeHtml } from "./escape-html.js";

interface CallAnalysis {
  call_summary?: string;
  user_sentiment?: string;
  call_successful?: boolean;
  in_voicemail?: boolean;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function isProblemCall(
  analysis: CallAnalysis,
  disconnectionReason: string,
): boolean {
  if (analysis.user_sentiment === "Negative") return true;
  if (analysis.call_successful === false) return true;
  if (analysis.in_voicemail === true) return true;
  if (disconnectionReason.startsWith("error_")) return true;
  return false;
}

export async function sendOwnerCallMonitor(
  call: Record<string, any>,
  clientConfig: ClientNotificationConfig,
  notificationOutcome: string,
): Promise<void> {
  // Skip test clients
  if (clientConfig.name.includes("Test")) return;

  const callId = call.call_id ?? "unknown";
  const fromNumber = call.from_number ?? "unknown";
  const durationMs = call.duration_ms ?? 0;
  const duration = formatDuration(durationMs);
  const disconnectionReason = call.disconnection_reason ?? "unknown";
  const transcript = call.transcript ?? "(no transcript)";
  const recordingUrl = call.recording_url ?? null;
  const publicLogUrl = call.public_log_url ?? null;

  const analysis: CallAnalysis = call.call_analysis ?? {};
  const sentiment = analysis.user_sentiment ?? "Unknown";
  const callSuccessful = analysis.call_successful;
  const callSummary = analysis.call_summary ?? "(no summary)";
  const inVoicemail = analysis.in_voicemail ?? false;

  const problem = isProblemCall(analysis, disconnectionReason);

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
  const successText =
    callSuccessful === true ? "Yes" : callSuccessful === false ? "No" : "Unknown";

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

  console.log(
    `owner-monitor: sent | client="${clientConfig.name}" | call_id=${callId} | problem=${problem}`,
  );
}
