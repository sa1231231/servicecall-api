import { Resend } from "resend";
import { config } from "../config.js";

const resend = new Resend(config.RESEND_API_KEY);

interface EmailOptions {
  to: string;
  cc?: string | null;
  subject: string;
  body: string;
  html?: string;
}

export async function sendEmail({ to, cc, subject, body, html }: EmailOptions) {
  const { data, error } = await resend.emails.send({
    from: config.EMAIL_FROM,
    to,
    cc: cc ?? undefined,
    subject,
    ...(html ? { html } : { text: body }),
  });

  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }

  const resendId = data?.id ?? "unknown";
  console.log(
    `notify-email: sent | to=${to}${cc ? ` | cc=${cc}` : ""} | subject="${subject}" | resend_id=${resendId}`,
  );
  return data;
}

export async function getEmailStatus(emailId: string) {
  const { data, error } = await resend.emails.get(emailId);
  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
  return data;
}
