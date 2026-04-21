interface EmailOptions {
    to: string;
    cc?: string | null;
    subject: string;
    body: string;
    html?: string;
}
export declare function sendEmail({ to, cc, subject, body, html }: EmailOptions): Promise<import("resend").CreateEmailResponseSuccess>;
export declare function getEmailStatus(emailId: string): Promise<import("resend").GetEmailResponseSuccess>;
export {};
