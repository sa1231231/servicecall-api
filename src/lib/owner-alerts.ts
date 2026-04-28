import type { Request } from "express";
import { ownerConfig } from "../config/notification-clients.js";
import { sendSms } from "./notify-sms.js";
import { sendEmail } from "./notify-email.js";

/**
 * Alert the owner via SMS + email when a non-owner user performs a destructive action.
 * Fire-and-forget — errors are logged but don't affect the response.
 */
export function alertOwnerIfNeeded(
  req: Request,
  action: string,
  target: string,
  details?: string,
): void {
  if (!req.user || req.user.isOwner) return;

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
    sendSms(ownerConfig.phone, smsMsg).catch((err) =>
      console.error("[owner-alert] SMS failed:", err),
    ),
    sendEmail({ to: ownerConfig.email, subject, body, html }).catch((err) =>
      console.error("[owner-alert] email failed:", err),
    ),
  ]).catch(() => {});
}
