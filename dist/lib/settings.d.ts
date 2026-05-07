export interface CostRates {
    twilio_sms_cents: number;
    resend_email_cents: number;
    twilio_number_monthly_cents: number;
}
export declare const DEFAULT_COST_RATES: CostRates;
/** A single setup-instruction template (e.g. Verizon, AT&T, RingCentral).
 *  Keyed by `id` so the dashboard's send dropdown can identify the choice
 *  while letting the operator rename `label` without breaking outstanding
 *  references. `message` may use {{business_name}} and {{agent_phone}}. */
export interface SetupInstruction {
    id: string;
    label: string;
    message: string;
}
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
    setup_instructions?: SetupInstruction[];
    category_order?: string[];
    category_labels?: Record<string, string>;
    cost_rates?: CostRates;
}
export declare function getSettings(): Promise<GlobalSettings>;
export declare function updateSettings(updates: Partial<GlobalSettings>): Promise<GlobalSettings>;
/** Load owner config from MongoDB into the in-memory ownerConfig object. */
export declare function refreshOwnerConfig(): Promise<void>;
