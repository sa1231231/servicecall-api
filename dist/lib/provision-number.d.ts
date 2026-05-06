interface ProvisionOptions {
    agentId: string;
    clientName: string;
    dispatchCallNumber?: string;
    areaCode?: number;
}
interface ProvisionResult {
    phoneNumber: string;
    phoneNumberSid: string;
}
export declare function extractAreaCode(phoneNumber: string): number;
export declare function provisionPhoneNumber(options: ProvisionOptions): Promise<ProvisionResult>;
export {};
