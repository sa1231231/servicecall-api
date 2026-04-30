import type { Request, Response } from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { updateClientField } from "../../config/client-store.js";
import { notificationClients } from "../../_cache/clients.js";

export async function toggleActiveHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = req.params.slug as string;
  const { active } = req.body;

  if (typeof active !== "boolean") {
    res.status(400).json({ error: "active must be a boolean" });
    return;
  }

  const client = notificationClients[slug];
  if (!client) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }

  const retell = new Retell({ apiKey: config.RETELL_API_KEY });

  // Find all Retell phone numbers that have any of this client's agent_ids
  // bound as inbound agents (or that match outbound_from_number).
  const allNumbers = await retell.phoneNumber.list();
  const clientAgentIds = new Set(client.agent_ids);

  const matchingNumbers = allNumbers.filter((n) => {
    // Match by inbound agent binding
    if (n.inbound_agents?.some((a) => clientAgentIds.has(a.agent_id))) return true;
    if (n.inbound_agent_id && clientAgentIds.has(n.inbound_agent_id)) return true;
    // Match by outbound_from_number (number may have had inbound agents cleared already)
    if (client.outbound_from_number && n.phone_number === client.outbound_from_number) return true;
    return false;
  });

  if (matchingNumbers.length === 0) {
    console.log(`[toggle-active] no Retell phone numbers found for "${slug}"`);
  }

  // Update each matching phone number's inbound agent binding
  const errors: string[] = [];
  for (const num of matchingNumbers) {
    try {
      if (active) {
        // Re-enable: bind the first agent_id as inbound agent
        const agentId = client.agent_ids[0];
        if (agentId) {
          await retell.phoneNumber.update(num.phone_number, {
            inbound_agents: [{ agent_id: agentId, weight: 1 }],
          });
          console.log(`[toggle-active] enabled inbound agent on ${num.phone_number} → ${agentId}`);
        }
      } else {
        // Disable: clear inbound agents so the number doesn't accept calls
        await retell.phoneNumber.update(num.phone_number, {
          inbound_agent_id: null,
          inbound_agents: null,
        });
        console.log(`[toggle-active] cleared inbound agents on ${num.phone_number}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[toggle-active] failed to update ${num.phone_number}: ${msg}`);
      errors.push(`${num.phone_number}: ${msg}`);
    }
  }

  if (errors.length > 0) {
    res.status(500).json({ error: "Failed to update Retell phone numbers", details: errors });
    return;
  }

  // Persist active state in MongoDB
  try {
    await updateClientField(slug, "active", active);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(404).json({ error: message });
    return;
  }

  console.log(`[toggle-active] ${slug} is now ${active ? "ACTIVE" : "INACTIVE"} (${matchingNumbers.length} number(s) updated)`);
  res.json({ success: true, slug, active, numbers_updated: matchingNumbers.length });
}
