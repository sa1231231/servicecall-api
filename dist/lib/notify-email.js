import { Resend } from "resend";
import { config } from "../config.js";
const resend = new Resend(config.RESEND_API_KEY);
export async function sendEmail({ to, cc, subject, body }) {
    const { data, error } = await resend.emails.send({
        from: config.EMAIL_FROM,
        to,
        cc: cc ?? undefined,
        subject,
        text: body,
    });
    if (error) {
        throw new Error(`Resend error: ${error.message}`);
    }
    console.log(`notify-email: sent to ${to}, id=${data?.id}`);
    return data;
}
