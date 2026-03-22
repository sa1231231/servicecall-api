import { Router } from "express";
import express from "express";
import { getSlotsHandler } from "./get-slots.js";
import { createAppointmentHandler } from "./create-appointment.js";

export const deckscienceRouter = Router();

deckscienceRouter.use(express.json());

deckscienceRouter.use((req, _res, next) => {
  if (req.body && Object.keys(req.body).length) {
    console.log(`[deckscience] ${req.method} ${req.path} body:`, JSON.stringify(req.body, null, 2));
  }
  next();
});

deckscienceRouter.post("/get-slots", getSlotsHandler);
deckscienceRouter.post("/create-appointment", createAppointmentHandler);
