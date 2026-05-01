import { sendSms } from "./notify-sms.js";
import { sendEmail } from "./notify-email.js";
// Immutable root contact — cannot be changed from the dashboard.
// This ensures alerts always reach root even if another admin
// modifies the owner_email/owner_phone in global settings.
const ROOT_EMAIL = "samasra93@gmail.com";
const ROOT_PHONE = "+13017872841";
/**
 * Alert root via SMS + email when a non-root user performs a destructive action.
 * Fire-and-forget — errors are logged but don't affect the response.
 */
export function alertRootIfNeeded(req, action, target, details) {
    if (!req.user || req.user.isRoot)
        return;
    const { username, role } = req.user;
    const time = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
    const ip = req.ip ?? "unknown";
    const smsMsg = `[SCS Alert] ${username} (${role}) performed: ${action} on "${target}"`;
    const subject = `[Alert] ${action} by ${username}`;
    const body = [
        `Action: ${action}`,
        `Target: ${target}`,
        `User: ${username} (${role})`,
        `Time: ${time}`,
        `IP: ${ip}`,
        details ? `Details: ${details}` : "",
    ].filter(Boolean).join("\n");
    const html = `
    <div style="font-family:sans-serif;font-size:14px;color:#333;">
      <h3 style="margin:0 0 12px;color:#dc2626;">Dashboard Action Alert</h3>
      <table style="border-collapse:collapse;">
        <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Action</td><td>${action}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Target</td><td>${target}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:600;">User</td><td>${username} (${role})</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Time</td><td>${time}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:600;">IP</td><td>${ip}</td></tr>
        ${details ? `<tr><td style="padding:4px 12px 4px 0;font-weight:600;">Details</td><td>${details}</td></tr>` : ""}
      </table>
    </div>`;
    // Fire-and-forget
    Promise.all([
        sendSms(ROOT_PHONE, smsMsg).catch((err) => console.error("[root-alert] SMS failed:", err)),
        sendEmail({ to: ROOT_EMAIL, subject, body, html }).catch((err) => console.error("[root-alert] email failed:", err)),
    ]).catch(() => { });
}
