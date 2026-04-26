interface ProvisionOptions {
    agentId: string;
    clientName: string;
    dispatchCallNumber: string;
}
interface ProvisionResult {
    phoneNumber: string;
    phoneNumberSid: string;
}
export declare function provisionPhoneNumber(options: ProvisionOptions): Promise<ProvisionResult>;
export {};
