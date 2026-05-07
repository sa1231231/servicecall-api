import type { Request, Response } from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { notificationClients } from "../../_cache/clients.js";
import {
  getClientDocument,
  persistClient,
  type JsonClientEntry,
} from "../../config/client-store.js";
import {
  fetchRetellAgent,
  extractFlowParams,
  extractAgentParams,
} from "../../lib/retell-sync.js";
import { generateSlug } from "../../lib/slug.js";
import { replaceBusinessName } from "../../lib/replace-business-name.js";
import { logAudit } from "../../lib/audit.js";

// ── FAQ node template (must match agent-generator/node-builders.ts) ──────────

const FAQ_NODE_NAME = "Admin/FAQ";
const FAQ_PROMPT_PREFIX = `Your goal is to answer administrative and general questions briefly and accurately.

`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function replaceFaq(
  flow: Record<string, unknown>,
  newFaq: string,
): Record<string, unknown> {
  const nodes = flow.nodes as Array<Record<string, unknown>> | undefined;
  if (!nodes) return flow;

  for (const node of nodes) {
    if (node.name === FAQ_NODE_NAME) {
      const instruction = node.instruction as Record<string, unknown> | undefined;
      if (instruction && typeof instruction.text === "string") {
        instruction.text = FAQ_PROMPT_PREFIX + newFaq;
      }
      break;
    }
  }
  return flow;
}

// ── POST /dashboard/api/agents/:slug/clone ──────────────────────────────────

interface CloneBody {
  name: string;
  faq: string;
  dispatch_text_numbers?: string[];
  dispatch_call_number?: string | null;
  dispatch_email?: string[] | null;
  dispatch_cc?: string | null;
  outbound_from_number?: string | null;
}

export async function cloneAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const sourceSlug = String(req.params.slug);
  const body = req.body as CloneBody;

  // Validate
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "Missing required field: name" });
    return;
  }
  if (!body.faq || typeof body.faq !== "string" || !body.faq.trim()) {
    res.status(400).json({ error: "Missing required field: faq" });
    return;
  }

  const newName = body.name.trim();
  const newFaq = body.faq.trim();

  // Fetch source
  const sourceDoc = await getClientDocument(sourceSlug);
  if (!sourceDoc) {
    res.status(404).json({ error: `Client "${sourceSlug}" not found` });
    return;
  }

  const sourceAgentId = sourceDoc.agent_id;
  if (!sourceAgentId) {
    res.status(400).json({ error: "Source client has no agent_id" });
    return;
  }

  // Generate slug
  const newSlug = generateSlug(newName);
  if (notificationClients[newSlug]) {
    res.status(409).json({ error: `Slug "${newSlug}" already exists` });
    return;
  }

  const retell = new Retell({ apiKey: config.RETELL_API_KEY });
  let newFlowId: string | undefined;

  try {
    console.log(`[clone-agent] fetching source agent ${sourceAgentId} from Retell...`);
    const snapshot = await fetchRetellAgent(retell, sourceAgentId);

    // Modify conversation flow: replace business name + FAQ
    let modifiedFlow = replaceBusinessName(
      snapshot.canonicalJson.conversationFlow as Record<string, unknown>,
      sourceDoc.name,
      newName,
    );
    modifiedFlow = replaceFaq(modifiedFlow, newFaq);

    // Create new conversation flow
    const flowParams = extractFlowParams(modifiedFlow);
    console.log(`[clone-agent] creating new conversation flow...`);
    const flowResponse = await retell.conversationFlow.create(flowParams as any);
    newFlowId = flowResponse.conversation_flow_id;
    console.log(`[clone-agent] flow created: ${newFlowId}`);

    // Create new agent
    const agentParams = extractAgentParams(snapshot.canonicalJson, newFlowId);
    agentParams.agent_name = newName;
    console.log(`[clone-agent] creating new agent...`);
    const agentResponse = await retell.agent.create(agentParams as any);
    const newAgentId = agentResponse.agent_id;
    console.log(`[clone-agent] agent created: ${newAgentId}`);

    // Build canonical JSON for the new agent
    const newCanonicalJson: Record<string, unknown> = {
      ...snapshot.canonicalJson,
      agent_id: newAgentId,
      agent_name: newName,
      conversationFlow: flowResponse as unknown as Record<string, unknown>,
    };

    // Build client entry — copy structure from source, use new dispatch config
    const entry: JsonClientEntry = {
      name: newName,
      agent_id: newAgentId,
      dispatch_text_numbers: body.dispatch_text_numbers ?? [],
      dispatch_call_number: body.dispatch_call_number ?? null,
      dispatch_email: body.dispatch_email ?? null,
      dispatch_cc: body.dispatch_cc ?? null,
      outbound_from_number: body.outbound_from_number ?? null,
      summary_agent_id: sourceDoc.summary_agent_id,
      message_types: JSON.parse(JSON.stringify(sourceDoc.message_types)),
      default_message_type: sourceDoc.default_message_type,
      resolve_rules: sourceDoc.resolve_rules
        ? JSON.parse(JSON.stringify(sourceDoc.resolve_rules))
        : undefined,
      resolve_rule: sourceDoc.resolve_rule
        ? JSON.parse(JSON.stringify(sourceDoc.resolve_rule))
        : undefined,
      phone_fallback_to_caller: sourceDoc.phone_fallback_to_caller,
      hide_not_mentioned: sourceDoc.hide_not_mentioned,
      shadow_mode: true,
      retell_agents: { [newAgentId]: newCanonicalJson },
    };

    await persistClient(newSlug, entry);

    console.log(`[clone-agent] client "${newSlug}" cloned from "${sourceSlug}"`);
    await logAudit(req, "clone_agent", newSlug, {
      source_slug: sourceSlug,
      new_agent_id: newAgentId,
      new_flow_id: newFlowId,
    });

    res.status(201).json({
      success: true,
      slug: newSlug,
      agent_id: newAgentId,
      source_slug: sourceSlug,
    });
  } catch (err: unknown) {
    console.error("[clone-agent] error:", err);

    // Cleanup: if we created a flow but agent creation failed
    if (newFlowId) {
      try {
        console.log(`[clone-agent] cleaning up flow ${newFlowId}`);
        await retell.conversationFlow.delete(newFlowId);
      } catch (cleanupErr) {
        console.error("[clone-agent] cleanup failed:", cleanupErr);
      }
    }

    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: "Failed to clone agent", details: message });
  }
}
