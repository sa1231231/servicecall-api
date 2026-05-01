import type { CostRates } from "./settings.js";
export interface MonthBucket {
    /** YYYY-MM */
    month: string;
    /** True if this is the current (incomplete) month. */
    is_partial: boolean;
    retell_cents: number;
    sms_count: number;
    sms_cents: number;
    email_count: number;
    email_cents: number;
    phone_number_days: number;
    phone_cents: number;
    total_cents: number;
}
export interface ClientCogsResponse {
    client_slug: string;
    rates: CostRates;
    current: MonthBucket;
    history: MonthBucket[];
}
/** Full COGS breakdown for one client: current MTD + the last `monthsBack` complete months. */
export declare function getClientCogs(client_slug: string, monthsBack?: number): Promise<ClientCogsResponse>;
/** Lightweight: MTD total cents per client, for the agent-list column. */
export declare function getMtdCogsForAllClients(): Promise<Record<string, number>>;
