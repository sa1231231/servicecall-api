import type { Request, Response } from "express";
import { config } from "../../config.js";

const LOCATION_ID = "UdWJQ2tT3Iu05l36sAyz";
const CALENDAR_ID = "xxCyQ9oSNEGdgFjIpMlC";
const BASE_URL = "https://services.leadconnectorhq.com";

export async function createAppointmentHandler(req: Request, res: Response) {
  console.log("deckscience-create-appointment: received request");

  try {
    const body = req.body;

    // Retell wraps everything in event_message as a string
    const parsedEvent = body?.event_message
      ? JSON.parse(body.event_message)
      : body;

    const dynamicVars = parsedEvent?.call?.retell_llm_dynamic_variables ?? {};
    const collectedVars = parsedEvent?.call?.collected_dynamic_variables ?? {};

    const start_iso =
      collectedVars?.matched_time_slot ?? dynamicVars?.matched_time_slot;

    const physical_address =
      collectedVars?.physical_address ?? dynamicVars?.physical_address ?? "";

    const contact_id =
      collectedVars?.contact_id ??
      dynamicVars?.contact_id ??
      "cgyF4ZXTnW2VQDzRCWpA";

    console.log("deckscience-create-appointment: extracted", {
      start_iso,
      physical_address,
      contact_id,
    });

    if (!start_iso) {
      res.status(400).json({ error: "iso is required" });
      return;
    }

    // 90 minute duration
    const startDate = new Date(start_iso);
    const endDate = new Date(startDate.getTime() + 90 * 60 * 1000);

    const payload = {
      title: "AI-PILOT: On-Site Consultation",
      description: `
On-site consultation booked via ServiceCall Saver.

Service Address:
${physical_address || "Not provided"}
      `.trim(),
      calendarId: CALENDAR_ID,
      locationId: LOCATION_ID,
      contactId: contact_id,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
      appointmentStatus: "confirmed",
      meetingLocationType: "custom",
      meetingLocationId: "custom_0",
      overrideLocationConfig: true,
      address: physical_address || "",
    };

    console.log("deckscience-create-appointment: sending payload to GHL", payload);

    const ghlRes = await fetch(`${BASE_URL}/calendars/events/appointments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.GHL_API_KEY}`,
        Version: "2021-04-15",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const rawText = await ghlRes.text();
    console.log("deckscience-create-appointment: raw GHL response", rawText);

    if (!ghlRes.ok) {
      res.status(ghlRes.status).send(rawText);
      return;
    }

    res.status(200).send(rawText);
  } catch (err) {
    console.error("deckscience-create-appointment: internal error", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
