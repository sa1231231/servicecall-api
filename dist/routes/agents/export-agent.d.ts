import type { Request, Response } from "express";
/**
 * Export an agent config as a JSON file compatible with POST /agents/create.
 * Reconstructs the create-body format from the stored canonical JSON.
 */
export declare function exportAgentHandler(req: Request, res: Response): Promise<void>;
