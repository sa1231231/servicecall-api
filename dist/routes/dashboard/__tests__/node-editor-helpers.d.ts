import type { Request, Response } from "express";
export type MockRes = Response & {
    _status: number;
    _json: any;
};
export declare function makeRes(): MockRes;
export declare function makeReq(opts: {
    params?: Record<string, string>;
    body?: any;
    query?: Record<string, any>;
    username?: string;
}): Request;
export declare function makeDoc(overrides?: Record<string, any>): {
    _id: string;
    name: string;
    agent_id: string;
    retell_agents: {
        agent_1: {
            conversationFlow: {
                nodes: never[];
            };
        };
    };
    dispatch_text_numbers: never[];
    dispatch_email: never[];
    message_types: {};
};
export declare function findRoute(router: any, method: string, path: string): any;
export declare function runRoute(router: any, method: string, path: string, req: Request, res: Response): Promise<void>;
