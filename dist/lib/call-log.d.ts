export interface CallLogDocument {
    _id: string;
    client_slug: string;
    client_name: string;
    agent_id: string;
    from_number: string;
    duration_ms: number;
    disconnection_reason: string;
    all_variables: Record<string, string>;
    extracted_fields: Record<string, string>;
    message_type_key: string;
    message_type_label: string;
    outcome: string;
    shadow_mode: boolean;
    call_summary?: string;
    user_sentiment?: string;
    call_successful?: boolean;
    in_voicemail?: boolean;
    recording_url?: string;
    public_log_url?: string;
    transcript?: string;
    call_cost_cents?: number;
    sms_count?: number;
    email_count?: number;
    created_at: Date;
}
/** Save a call log document (fire-and-forget safe). */
export declare function saveCallLog(doc: CallLogDocument): Promise<void>;
/** Enrich a call log with analysis data from Retell (called by owner-monitor). */
export declare function enrichCallLog(callId: string, data: {
    call_summary?: string;
    user_sentiment?: string;
    call_successful?: boolean;
    in_voicemail?: boolean;
    recording_url?: string;
    public_log_url?: string;
    transcript?: string;
}): Promise<void>;
/** Get a single call log by ID. */
export declare function getCallLogById(callId: string): Promise<CallLogDocument | null>;
/** Get call logs for a client, sorted newest first. */
export declare function getCallLogsByClient(clientSlug: string, limit?: number, offset?: number): Promise<CallLogDocument[]>;
