import { Router } from "express";
import express from "express";
import { createAgentHandler } from "./create-agent.js";
import {
  importAgentHandler,
  syncAgentHandler,
  duplicateAgentHandler,
} from "./sync-agent.js";

export const agentsRouter = Router();
agentsRouter.use(express.json());
agentsRouter.post("/create", createAgentHandler);
agentsRouter.post("/import", importAgentHandler);
agentsRouter.post("/:slug/sync", syncAgentHandler);
agentsRouter.post("/duplicate", duplicateAgentHandler);
