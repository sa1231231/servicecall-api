import type { Request, Response } from "express";
import { getAllClientSummaries } from "../../config/client-store.js";

export function listAgentsHandler(_req: Request, res: Response): void {
  res.json(getAllClientSummaries());
}
