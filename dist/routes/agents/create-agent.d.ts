import type { Request, Response } from "express";
export type { CreateAgentBody } from "../../lib/agent-from-config.js";
export declare function createAgentHandler(req: Request, res: Response): Promise<void>;
