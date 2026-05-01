export interface BlastRecipient {
    number: string;
    clientName: string;
}
export interface BlastResult {
    total_recipients: number;
    total_clients: number;
    sent: number;
    failed: Array<{
        number: string;
        error: string;
    }>;
}
export interface BlastPreview {
    total_recipients: number;
    total_clients: number;
    sample_message: string;
}
/** Gather all eligible recipients (active, non-shadow clients). */
export declare function gatherRecipients(): {
    recipients: BlastRecipient[];
    clientCount: number;
};
/** Replace {{client_name}} in the message template. */
export declare function personalizeMessage(template: string, clientName: string): string;
/** Preview the blast without sending. */
export declare function previewBlast(message: string): BlastPreview;
/** Send an SMS blast with 1-second delay between each message. */
export declare function sendBlast(message: string): Promise<BlastResult>;
