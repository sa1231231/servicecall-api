export declare function sendSms(to: string, message: string): Promise<import("twilio/lib/rest/api/v2010/account/message.js").MessageInstance>;
export declare function sendSmsToAll(numbers: string[], message: string): Promise<PromiseSettledResult<import("twilio/lib/rest/api/v2010/account/message.js").MessageInstance>[]>;
