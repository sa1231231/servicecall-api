import { Router } from "express";
import express from "express";
import { webhookHandler } from "./webhook.js";
export const stripeRouter = Router();
// Stripe signature verification requires the raw body buffer
stripeRouter.use(express.raw({ type: "*/*" }));
stripeRouter.post("/webhook", webhookHandler);
