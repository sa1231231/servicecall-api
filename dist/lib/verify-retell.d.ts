import type { Response } from "express";
export declare function verifyRetellWebhookOrThrow(rawBody: string, signature: string, signatureKey: string): void;
export declare function verifyRetellWebhookOr401(rawBody: string, signature: string, signatureKey: string, res: Response): boolean;
