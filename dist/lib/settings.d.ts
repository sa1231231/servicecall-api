export interface GlobalSettings {
    google_review_url: string;
    review_sms_message: string;
}
export declare function getSettings(): Promise<GlobalSettings>;
export declare function updateSettings(updates: Partial<GlobalSettings>): Promise<GlobalSettings>;
