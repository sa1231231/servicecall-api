export interface CostRates {
    twilio_sms_cents: number;
    resend_email_cents: number;
    twilio_number_monthly_cents: number;
}
export declare const DEFAULT_COST_RATES: CostRates;
export interface GlobalSettings {
    google_review_url: string;
    review_sms_message: string;
    stripe_payment_url: string;
    payment_sms_message: string;
    portal_sms_message: string;
    free_trial_days: number;
    owner_email: string;
    owner_phone: string;
    default_summary_agent_id: string;
    category_order?: string[];
    category_labels?: Record<string, string>;
    cost_rates?: CostRates;
}
export declare function getSettings(): Promise<GlobalSettings>;
export declare function updateSettings(updates: Partial<GlobalSettings>): Promise<GlobalSettings>;
/** Load owner config from MongoDB into the in-memory ownerConfig object. */
export declare function refreshOwnerConfig(): Promise<void>;
