import { Router } from "express";
import express from "express";
import { preHookHandler } from "./pre-hook.js";
import { postHookHandler } from "./post-hook.js";

export const retellRouter = Router();

// Retell HMAC verification requires the raw body string,
// so capture it via the verify callback while still parsing JSON.
retellRouter.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf.toString();
    },
  }),
);

retellRouter.post("/pre-hook", preHookHandler);
retellRouter.post("/post-hook", postHookHandler);
