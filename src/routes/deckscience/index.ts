import { Router } from "express";
import express from "express";
import { getSlotsHandler } from "./get-slots.js";
import { createAppointmentHandler } from "./create-appointment.js";

export const deckscienceRouter = Router();

deckscienceRouter.use(express.json());

deckscienceRouter.post("/get-slots", getSlotsHandler);
deckscienceRouter.post("/create-appointment", createAppointmentHandler);
