import { Router, json } from "express";
import Retell from "retell-sdk";
import { config } from "../config.js";
import { getClientDocument, toClientConfig } from "../config/client-store.js";
import { runSmokeTest, buildSyntheticVariables } from "../lib/qa-smoke.js";
import { buildNotificationMessages } from "../lib/build-notification.js";
import { sendSmsToAll } from "../lib/notify-sms.js";
import { sendEmail } from "../lib/notify-email.js";
import { ownerConfig } from "../config/notification-clients.js";

export const qaRouter = Router();
qaRouter.use(json());

qaRouter.post("/smoke/:slug", async (req, res) => {
  const { slug } = req.params;
  const notify = req.query.notify === "true";

  const clientDoc = await getClientDocument(slug);
  if (!clientDoc) {
    res.status(404).json({ error: `Client '${slug}' not found` });
    return;
  }

  if (clientDoc.agent_ids.length === 0) {
    res.status(400).json({ error: `Client '${slug}' has no agent_ids` });
    return;
  }

  try {
    const retell = new Retell({ apiKey: config.RETELL_API_KEY });
    const report = await runSmokeTest(retell, clientDoc, {
      notify,
      postHookUrl: `${req.protocol}://${req.get("host")}/retell/post-hook`,
    });
    res.json(report);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[qa/smoke] unhandled error for slug="${slug}":`, msg);
    res.status(500).json({ error: msg });
  }
});

qaRouter.post("/test-notify/:slug", async (req, res) => {
  const { slug } = req.params;

  const clientDoc = await getClientDocument(slug);
  if (!clientDoc) {
    res.status(404).json({ error: `Client '${slug}' not found` });
    return;
  }

  try {
    const clientConfig = toClientConfig(clientDoc);
    const syntheticVars = buildSyntheticVariables(clientDoc);

    const result = buildNotificationMessages({
      clientConfig,
      allVars: syntheticVars,
      callerNumber: "+15550000000",
    });

    if (!result.ok) {
      res.status(400).json({ error: "Message build failed", reason: result.reason, details: result.details });
      return;
    }

    const { smsMessage, emailBody, emailHtml, emailSubject, typeKey } = result.payload;

    const tasks: Promise<unknown>[] = [
      sendSmsToAll([ownerConfig.phone], smsMessage),
      sendEmail({ to: ownerConfig.email, subject: emailSubject, body: emailBody, html: emailHtml }),
    ];

    const results = await Promise.allSettled(tasks);
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason?.message ?? String(r.reason));

    if (errors.length > 0) {
      console.error(`[qa/test-notify] send errors for slug="${slug}":`, errors);
      res.status(500).json({ success: false, errors });
      return;
    }

    console.log(`[qa/test-notify] sent test notification for slug="${slug}" (type=${typeKey})`);
    res.json({
      success: true,
      message_type: typeKey,
      sent_to: { sms: ownerConfig.phone, email: ownerConfig.email },
      preview: { sms: smsMessage, email_subject: emailSubject },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[qa/test-notify] unhandled error for slug="${slug}":`, msg);
    res.status(500).json({ error: msg });
  }
});
