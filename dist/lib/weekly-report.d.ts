import type { JsonClientEntry } from "../config/client-store.js";
export declare function sendWeeklyReportForClient(doc: JsonClientEntry & {
    _id: string;
}): Promise<void>;
export declare function runWeeklyReports(clientId?: string): Promise<{
    sent: string[];
    skipped: string[];
    errors: string[];
}>;
export declare function startWeeklyReportScheduler(): void;
