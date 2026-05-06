import type { Request, Response } from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { notificationClients } from "../../_cache/clients.js";
import {
  persistClient,
  getClientDocument,
  type JsonClientEntry,
} from "../../config/client-store.js";
import {
  deriveNotificationConfig,
  type ClientInfo,
} from "../../lib/notification-config.js";
import {
  fetchRetellAgent,
  extractFlowParams,
  extractAgentParams,
} from "../../lib/retell-sync.js";
import { generateSlug } from "../../lib/slug.js";

// ── POST /agents/import ──────────────────────────────────────────────────────

interface ImportBody {
  agent_id: string;
  client?: Partial<ClientInfo>;
}

export async function importAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as ImportBody;

  // Validate
  if (!body.agent_id) {
    res.status(400).json({ error: "Missing required field: agent_id" });
    return;
  }
  // Require an explicit client.name. We used to silently fall back to the
  // Retell agent's `agent_name` when this was missing, but that meant
  // imports could pick up template-prefixed or "[DELETED]" names without
  // the caller realizing — fail loudly instead of guessing.
  if (typeof body.client?.name !== "string" || !body.client.name.trim()) {
    res.status(400).json({
      error: "Missing required field: client.name (no fallback to Retell's agent_name)",
    });
    return;
  }
  const explicitName = body.client.name.trim();

  const retell = new Retell({ apiKey: config.RETELL_API_KEY });

  try {
    console.log(`[import-agent] fetching agent ${body.agent_id} from Retell...`);
    const snapshot = await fetchRetellAgent(retell, body.agent_id);

    const slug = body.client?.slug || generateSlug(explicitName);
    if (notificationClients[slug]) {
      res.status(409).json({ error: `Client slug "${slug}" already exists` });
      return;
    }

    const clientInfo: ClientInfo = {
      slug,
      name: explicitName,
      dispatch_text_numbers: body.client?.dispatch_text_numbers ?? [],
      dispatch_call_number: body.client?.dispatch_call_number,
      dispatch_email: body.client?.dispatch_email,
      dispatch_cc: body.client?.dispatch_cc,
      outbound_from_number: body.client?.outbound_from_number,
      summary_agent_id: body.client?.summary_agent_id,
      phone_fallback_to_caller: body.client?.phone_fallback_to_caller,
      hide_not_mentioned: body.client?.hide_not_mentioned,
      shadow_mode: body.client?.shadow_mode ?? true,
    };

    const jsonEntry = deriveNotificationConfig(
      snapshot.variables,
      clientInfo,
      snapshot.agentId,
    );
    jsonEntry.retell_agents = { [snapshot.agentId]: snapshot.canonicalJson };

    await persistClient(slug, jsonEntry);

    console.log(`[import-agent] client "${slug}" imported with agent ${snapshot.agentId}`);

    res.status(201).json({
      success: true,
      slug,
      agent_id: snapshot.agentId,
      agent_name: snapshot.agentName,
      conversation_flow_id: snapshot.conversationFlowId,
      variables: snapshot.variables,
      notification_config: jsonEntry,
    });
  } catch (err: unknown) {
    console.error("[import-agent] error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: "Failed to import agent from Retell", details: message });
  }
}

// ── POST /agents/:slug/sync ─────────────────────────────────────────────────

export async function syncAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = req.params.slug as string;

  const existingDoc = await getClientDocument(slug);
  if (!existingDoc) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }

  // Allow specifying which agent_id to sync via query param, default to first
  const rawAgentId = req.query.agent_id;
  const agentId =
    (typeof rawAgentId === "string" ? rawAgentId : undefined) ||
    existingDoc.agent_id;
  if (!agentId) {
    res.status(400).json({ error: "No agent_id found for this client" });
    return;
  }

  const retell = new Retell({ apiKey: config.RETELL_API_KEY });

  try {
    console.log(`[sync-agent] fetching agent ${agentId} from Retell for "${slug}"...`);
    const snapshot = await fetchRetellAgent(retell, agentId);

    // Derive new notification config, preserving existing dispatch info
    const clientInfo: ClientInfo = {
      slug,
      name: existingDoc.name,
      dispatch_text_numbers: existingDoc.dispatch_text_numbers,
      dispatch_call_number: existingDoc.dispatch_call_number,
      dispatch_email: existingDoc.dispatch_email,
      dispatch_cc: existingDoc.dispatch_cc,
      outbound_from_number: existingDoc.outbound_from_number,
      summary_agent_id: existingDoc.summary_agent_id,
      phone_fallback_to_caller: existingDoc.phone_fallback_to_caller,
      hide_not_mentioned: existingDoc.hide_not_mentioned,
      shadow_mode: existingDoc.shadow_mode,
    };

    const jsonEntry = deriveNotificationConfig(
      snapshot.variables,
      clientInfo,
      agentId,
    );

    // Preserve field-level customizations (show, label) from existing config.
    // Build a global map from ALL existing message types so customizations
    // survive even when message_type keys change (e.g. multi-path agents).
    if (existingDoc.message_types) {
      const customizations = new Map<string, { show?: boolean; label: string }>();
      for (const existingType of Object.values(existingDoc.message_types)) {
        for (const f of existingType.fields) {
          if (!customizations.has(f.key)) {
            customizations.set(f.key, { show: f.show, label: f.label });
          }
        }
      }
      for (const newType of Object.values(jsonEntry.message_types)) {
        for (const field of newType.fields) {
          const existing = customizations.get(field.key);
          if (!existing) continue;
          if (existing.show === false) field.show = false;
          if (existing.label !== field.label) field.label = existing.label;
        }
      }
    }

    // Build the merged entry as an explicit allowlist rather than a
    // blocklist-by-omission spread. Adding a new field to JsonClientEntry
    // forces a conscious decision here about whether sync should re-derive
    // it from Retell or preserve the operator's value — instead of silently
    // inheriting from existingDoc and risking stale-data bugs.
    const mergedEntry: JsonClientEntry = {
      // ── Identity (preserved from existingDoc; sync never renames a client) ──
      agent_id: existingDoc.agent_id,
      name: existingDoc.name,
      display_name: existingDoc.display_name,

      // ── Notification structure (re-derived from Retell variables) ──
      // message_types arrives from jsonEntry but with field-level
      // customizations already merged in above (lines 148-174), so we
      // take it from jsonEntry rather than existingDoc.
      message_types: jsonEntry.message_types,
      default_message_type: jsonEntry.default_message_type,
      resolve_rule: jsonEntry.resolve_rule,

      // ── Dispatch routing (preserved — operator-configured) ──
      dispatch_text_numbers: existingDoc.dispatch_text_numbers,
      dispatch_call_number: existingDoc.dispatch_call_number,
      dispatch_call_overrides: existingDoc.dispatch_call_overrides,
      dispatch_by_type: existingDoc.dispatch_by_type,
      path_end_modes: existingDoc.path_end_modes,
      dispatch_email: existingDoc.dispatch_email,
      dispatch_cc: existingDoc.dispatch_cc,
      outbound_from_number: existingDoc.outbound_from_number,
      summary_agent_id: existingDoc.summary_agent_id,

      // ── Behavior flags (preserved — operator-configured) ──
      shadow_mode: existingDoc.shadow_mode,
      active: existingDoc.active,
      phone_fallback_to_caller: existingDoc.phone_fallback_to_caller,
      hide_not_mentioned: existingDoc.hide_not_mentioned,
      notification_greeting: existingDoc.notification_greeting,
      webhook_url: existingDoc.webhook_url,
      weekly_report_enabled: existingDoc.weekly_report_enabled,
      trial_start_date: existingDoc.trial_start_date,

      // ── Admin/contact metadata (preserved) ──
      contact_name: existingDoc.contact_name,
      contact_phone: existingDoc.contact_phone,
      contact_email: existingDoc.contact_email,
      contact_timezone: existingDoc.contact_timezone,
      contact_notes: existingDoc.contact_notes,
      folder_id: existingDoc.folder_id,
      portal_token: existingDoc.portal_token,

      // ── System-managed (snapshot updated) ──
      retell_agents: {
        ...(existingDoc.retell_agents ?? {}),
        [agentId]: snapshot.canonicalJson,
      },
      last_deployed_at: existingDoc.last_deployed_at,
    };
    // Preserve existing resolve_rules if manually configured (overrides the
    // single resolve_rule derived from the snapshot).
    if (existingDoc.resolve_rules && existingDoc.resolve_rules.length > 0) {
      mergedEntry.resolve_rules = existingDoc.resolve_rules;
      delete mergedEntry.resolve_rule;
    }

    await persistClient(slug, mergedEntry);

    console.log(`[sync-agent] client "${slug}" synced from Retell agent ${agentId}`);

    res.status(200).json({
      success: true,
      agent_id: agentId,
      agent_name: snapshot.agentName,
      variables: snapshot.variables,
      notification_config: jsonEntry,
    });
  } catch (err: unknown) {
    console.error("[sync-agent] error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: "Failed to sync agent from Retell", details: message });
  }
}

// ── POST /agents/duplicate ──────────────────────────────────────────────────

interface DuplicateBody {
  source_agent_id: string;
  client?: Partial<ClientInfo>;
}

export async function duplicateAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as DuplicateBody;

  // Validate
  if (!body.source_agent_id) {
    res.status(400).json({ error: "Missing required field: source_agent_id" });
    return;
  }
  // Require an explicit client.name. The previous fallback to the source
  // agent's Retell `agent_name` quietly produced duplicates whose slug and
  // notifications inherited the source's name — fail loudly instead.
  if (typeof body.client?.name !== "string" || !body.client.name.trim()) {
    res.status(400).json({
      error: "Missing required field: client.name (no fallback to source agent's name)",
    });
    return;
  }
  const agentName = body.client.name.trim();

  const retell = new Retell({ apiKey: config.RETELL_API_KEY });
  let newFlowId: string | undefined;

  try {
    console.log(`[duplicate-agent] fetching source agent ${body.source_agent_id} from Retell...`);
    const snapshot = await fetchRetellAgent(retell, body.source_agent_id);

    const slug = body.client?.slug || generateSlug(agentName);
    if (notificationClients[slug]) {
      res.status(409).json({ error: `Client slug "${slug}" already exists` });
      return;
    }

    // 1. Create new conversation flow (copy of source)
    const flowParams = extractFlowParams(
      snapshot.canonicalJson.conversationFlow as Record<string, unknown>,
    );
    console.log(`[duplicate-agent] creating new conversation flow...`);
    const flowResponse = await retell.conversationFlow.create(flowParams as any);
    newFlowId = flowResponse.conversation_flow_id;
    console.log(`[duplicate-agent] flow created: ${newFlowId}`);

    // 2. Create new agent (copy of source, linked to new flow)
    const agentParams = extractAgentParams(snapshot.canonicalJson, newFlowId);
    agentParams.agent_name = agentName;

    console.log(`[duplicate-agent] creating new agent...`);
    const agentResponse = await retell.agent.create(agentParams as any);
    const newAgentId = agentResponse.agent_id;
    console.log(`[duplicate-agent] agent created: ${newAgentId}`);

    // 3. Build canonical JSON for the new agent
    const newCanonicalJson: Record<string, unknown> = {
      ...snapshot.canonicalJson,
      agent_id: newAgentId,
      agent_name: agentName,
    };
    // Update the nested flow reference
    const newFlowObj = flowResponse as unknown as Record<string, unknown>;
    newCanonicalJson.conversationFlow = newFlowObj;

    // 4. Derive notification config and persist
    const clientInfo: ClientInfo = {
      slug,
      name: agentName,
      dispatch_text_numbers: body.client?.dispatch_text_numbers ?? [],
      dispatch_call_number: body.client?.dispatch_call_number,
      dispatch_email: body.client?.dispatch_email,
      dispatch_cc: body.client?.dispatch_cc,
      outbound_from_number: body.client?.outbound_from_number,
      summary_agent_id: body.client?.summary_agent_id,
      phone_fallback_to_caller: body.client?.phone_fallback_to_caller,
      hide_not_mentioned: body.client?.hide_not_mentioned,
      shadow_mode: body.client?.shadow_mode ?? true,
    };

    const jsonEntry = deriveNotificationConfig(
      snapshot.variables,
      clientInfo,
      newAgentId,
    );
    jsonEntry.retell_agents = { [newAgentId]: newCanonicalJson };

    await persistClient(slug, jsonEntry);

    console.log(`[duplicate-agent] client "${slug}" created with agent ${newAgentId}`);

    res.status(201).json({
      success: true,
      slug,
      agent_id: newAgentId,
      conversation_flow_id: newFlowId,
      source_agent_id: body.source_agent_id,
      variables: snapshot.variables,
      notification_config: jsonEntry,
    });
  } catch (err: unknown) {
    console.error("[duplicate-agent] error:", err);

    // Cleanup: if we created a flow but agent creation failed
    if (newFlowId) {
      try {
        console.log(`[duplicate-agent] cleaning up flow ${newFlowId}`);
        await retell.conversationFlow.delete(newFlowId);
      } catch (cleanupErr) {
        console.error("[duplicate-agent] cleanup failed:", cleanupErr);
      }
    }

    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: "Failed to duplicate agent in Retell", details: message });
  }
}
