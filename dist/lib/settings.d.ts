export interface GlobalSettings {
    google_review_url: string;
    review_sms_message: string;
    owner_email: string;
    owner_phone: string;
}
export declare function getSettings(): Promise<GlobalSettings>;
export declare function updateSettings(updates: Partial<GlobalSettings>): Promise<GlobalSettings>;
/** Load owner config from MongoDB into the in-memory ownerConfig object. */
export declare function refreshOwnerConfig(): Promise<void>;
