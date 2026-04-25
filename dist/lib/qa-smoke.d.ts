import type Retell from "retell-sdk";
import { type RetellAgentSnapshot } from "./retell-sync.js";
import type { JsonClientEntry } from "../config/client-store.js";
export type CheckStatus = "pass" | "fail" | "warn" | "skip";
export interface CheckResult {
    check: string;
    status: CheckStatus;
    message: string;
}
export interface SmokeReport {
    slug: string;
    agent_id: string;
    timestamp: string;
    duration_ms: number;
    overall: "pass" | "fail";
    summary: {
        total: number;
        pass: number;
        fail: number;
        warn: number;
        skip: number;
    };
    checks: CheckResult[];
}
export interface SmokeTestOptions {
    notify?: boolean;
    postHookUrl?: string;
}
export declare function buildSyntheticVariables(clientDoc: JsonClientEntry): Record<string, string>;
export declare function checkGreetingBusinessName(snapshot: RetellAgentSnapshot, clientDoc: JsonClientEntry): CheckResult;
export declare function checkDataPointsInFlow(snapshot: RetellAgentSnapshot, clientDoc: JsonClientEntry): CheckResult;
export declare function checkNotificationConfigComplete(clientDoc: JsonClientEntry): CheckResult;
export declare function checkMessageTypeResolves(clientDoc: JsonClientEntry): CheckResult;
export declare function checkRequiredFieldsSatisfiable(snapshot: RetellAgentSnapshot, clientDoc: JsonClientEntry): CheckResult;
export declare function runSmokeTest(retell: Retell, clientDoc: JsonClientEntry & {
    _id: string;
}, options?: SmokeTestOptions): Promise<SmokeReport>;
