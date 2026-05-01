export type PhoneEvent = "provisioned" | "released";
export interface PhoneNumberHistoryDoc {
    client_slug: string;
    phone_number: string;
    phone_number_sid: string;
    event: PhoneEvent;
    at: Date;
}
/** Append a provision/release event for a client's phone number. Fire-and-forget safe. */
export declare function logPhoneEvent(client_slug: string, phone_number: string, phone_number_sid: string, event: PhoneEvent, at?: Date): Promise<void>;
/**
 * For each phone number that was ever assigned to this client, compute the number of days
 * within [start, end) during which the number was active (provisioned but not yet released).
 * Returns the total number-days summed across all numbers.
 */
export declare function getNumberDaysInRange(client_slug: string, start: Date, end: Date): Promise<number>;
/**
 * One-time backfill: for each client with a currently-assigned outbound_from_number that
 * has no provisioning event recorded, emit a synthetic `provisioned` event dated today.
 * Safe to re-run — checks for an existing event before writing. Returns the number of
 * synthetic events written.
 */
export declare function backfillCurrentPhoneNumbers(clients: Array<{
    client_slug: string;
    phone_number: string;
    phone_number_sid?: string;
}>, at?: Date): Promise<number>;
