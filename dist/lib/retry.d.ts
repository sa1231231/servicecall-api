export interface RetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    label?: string;
}
export declare function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>;
