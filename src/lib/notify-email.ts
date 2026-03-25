import nodemailer from "nodemailer";
import { config } from "../config.js";

interface EmailOptions {
  to: string;
  cc?: string | null;
  subject: string;
  body: string;
}

export async function sendEmail({ to, cc, subject, body }: EmailOptions) {
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: Number(config.SMTP_PORT),
    secure: Number(config.SMTP_PORT) === 465,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    },
  });

  const info = await transporter.sendMail({
    from: config.SMTP_FROM,
    to,
    cc: cc ?? undefined,
    subject,
    text: body,
  });
  console.log(`notify-email: sent to ${to}, messageId=${info.messageId}`);
  return info;
}
