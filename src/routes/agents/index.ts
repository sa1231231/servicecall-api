import { Router } from "express";
import express from "express";
import { createAgentHandler } from "./create-agent.js";

export const agentsRouter = Router();
agentsRouter.use(express.json());
agentsRouter.post("/create", createAgentHandler);
