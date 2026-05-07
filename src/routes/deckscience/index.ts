import { Router } from "express";
import express from "express";
import { getSlotsHandler } from "./get-slots.js";
import { createAppointmentHandler } from "./create-appointment.js";

export const deckscienceRouter = Router();

deckscienceRouter.use(express.json());

deckscienceRouter.use((req, _res, next) => {
  // Log only the request shape — appointment payloads carry customer
  // names, phones, and free-text notes that shouldn't land in Railway logs.
  if (req.body && Object.keys(req.body).length) {
    console.log(`[deckscience] ${req.method} ${req.path} body keys:`, Object.keys(req.body).join(","));
  }
  next();
});

deckscienceRouter.post("/get-slots", getSlotsHandler);
deckscienceRouter.post("/create-appointment", createAppointmentHandler);
