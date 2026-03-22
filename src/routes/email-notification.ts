import { Router } from "express";
import express from "express";
import { config } from "../config.js";

export const emailNotificationRouter = Router();

emailNotificationRouter.use(express.json());

emailNotificationRouter.post("/", async (req, res) => {
  console.log("email-notification: received request");

  try {
    const body = req.body;

    console.dir(body, { depth: null });

    // Retell wraps everything in event_message as a string
    const parsedEvent = body?.event_message
      ? JSON.parse(body.event_message)
      : body;

    const dynamicVars = parsedEvent?.call?.retell_llm_dynamic_variables ?? {};
    const collectedVars = parsedEvent?.call?.collected_dynamic_variables ?? {};

    const company_name =
      collectedVars?.company_name ?? dynamicVars?.company_name ?? "";
    const full_name = collectedVars?.full_name ?? dynamicVars?.full_name ?? "";
    const raw_phone =
      collectedVars?.phone_number ?? dynamicVars?.phone_number ?? "";
    const phone_number =
      raw_phone && raw_phone !== "Not Mentioned"
        ? raw_phone
        : (parsedEvent?.call?.from_number ?? "");
    const truck_number =
      collectedVars?.truck_number ?? dynamicVars?.truck_number ?? "";
    const driver_name =
      collectedVars?.driver_name ?? dynamicVars?.driver_name ?? "";
    const driver_phone =
      collectedVars?.driver_phone ?? dynamicVars?.driver_phone ?? "";
    const breakdown_location =
      collectedVars?.breakdown_location ??
      dynamicVars?.breakdown_location ??
      "";
    const problem_description =
      collectedVars?.problem_description ??
      dynamicVars?.problem_description ??
      "";
    const whos_paying =
      collectedVars?.whos_paying ?? dynamicVars?.whos_paying ?? "";

    const DISPATCH_EMAIL = "sam@servicecallsaver.com";

    const timestamp = new Date().toLocaleString("en-US", {
      timeZone: "America/Indiana/Indianapolis",
      dateStyle: "full",
      timeStyle: "short",
    });

    console.log("email-notification: extracted", {
      company_name,
      full_name,
      phone_number,
      truck_number,
      driver_name,
      driver_phone,
      breakdown_location,
      problem_description,
      whos_paying,
    });

    const subject = `New Dispatch Request: ${company_name} — Truck ${truck_number}`;

    const emailHtml = `
<p>New service request received via phone:</p>
<p>
  <b>Company:</b> ${company_name}<br/>
  <b>Caller:</b> ${full_name}<br/>
  <b>Callback:</b> ${phone_number}<br/>
  <b>Truck #:</b> ${truck_number}<br/>
  <b>Driver:</b> ${driver_name}<br/>
  <b>Driver Phone:</b> ${driver_phone}<br/>
  <b>Location:</b> ${breakdown_location}<br/>
  <b>Problem:</b> ${problem_description}<br/>
  <b>Paying Party:</b> ${whos_paying}
</p>
<p><b>Received:</b> ${timestamp}</p>
<br/>
<p style="color:#888;font-size:12px;">Sent automatically by Service Call Saver</p>
`.trim();

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "ServiceCall Saver <notification@servicecallsaver.com>",
        to: [DISPATCH_EMAIL],
        subject,
        html: emailHtml,
      }),
    });

    const rawText = await resendRes.text();
    console.log("email-notification: Resend response", rawText);

    if (!resendRes.ok) {
      res.status(resendRes.status).send(rawText);
      return;
    }

    res.status(200).json({ ok: true, message: "Email sent successfully" });
  } catch (err) {
    console.error("email-notification: internal error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
