import { Router } from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { getClientDocument, loadClientsFromDb, type JsonClientEntry } from "../../config/client-store.js";
import { getDb } from "../../lib/db.js";
import { fetchRetellAgent, pushFlowToRetell, extractVariables } from "../../lib/retell-sync.js";
import { parseConversationFlow } from "../../lib/node-parser.js";
import { validateConversationFlow } from "../../lib/node-validator.js";
import {
  createVersionSnapshot,
  listVersions,
  getVersion,
  getLatestVersion,
} from "../../lib/agent-versions.js";
import { logAudit } from "../../lib/audit.js";
import { requireRoot } from "../../middleware/require-role.js";
import {
  deriveNotificationConfig,
  type ClientInfo,
} from "../../lib/notification-config.js";
import { regenerateDataChain, applyRegeneratedChain } from "../../lib/node-regenerator.js";
import { getDataPointDefaults } from "../../lib/data-point-defaults.js";
import { resolveDataPoints } from "../../lib/agent-generator/generate-agent.js";
import type { DataPoint } from "../../lib/agent-generator/data-point-registry.js";

export const nodeEditorRouter = Router({ mergeParams: true });

function retell() {
  return new Retell({ apiKey: config.RETELL_API_KEY });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function resolveAgentId(
  slug: string,
  agentIdParam: string,
): Promise<{ doc: JsonClientEntry & { _id: string }; agentId: string } | null> {
  const doc = await getClientDocument(slug);
  if (!doc) return null;
  const agentIds = doc.agent_ids ?? [];
  if (!agentIds.includes(agentIdParam)) return null;
  return { doc, agentId: agentIdParam };
}

async function pullLatest(agentId: string) {
  const snapshot = await fetchRetellAgent(retell(), agentId);
  return snapshot;
}

async function storeCanonical(
  slug: string,
  agentId: string,
  canonicalJson: Record<string, unknown>,
  doc: JsonClientEntry & { _id: string },
): Promise<void> {
  // Update the retell_agents entry and last_deployed_at
  await getDb()
    .collection<JsonClientEntry & { _id: string }>("clients")
    .updateOne({ _id: slug } as any, {
      $set: {
        [`retell_agents.${agentId}`]: canonicalJson,
        last_deployed_at: new Date().toISOString(),
      },
    });

  // Re-derive notification config if variables changed
  const variables = extractVariables(canonicalJson);
  const clientInfo: ClientInfo = {
    slug,
    name: doc.name,
    dispatch_text_numbers: doc.dispatch_text_numbers,
    dispatch_call_number: doc.dispatch_call_number,
    dispatch_email: doc.dispatch_email,
    dispatch_cc: doc.dispatch_cc,
    outbound_from_number: doc.outbound_from_number,
    summary_agent_id: doc.summary_agent_id,
    phone_fallback_to_caller: doc.phone_fallback_to_caller,
    hide_not_mentioned: doc.hide_not_mentioned,
    shadow_mode: doc.shadow_mode,
  };
  const derived = deriveNotificationConfig(variables, clientInfo, agentId);

  // Preserve existing field customizations
  if (doc.message_types) {
    const customizations = new Map<string, { show?: boolean; label: string; required?: true | { equals: string | string[] } }>();
    for (const existingType of Object.values(doc.message_types)) {
      for (const f of existingType.fields) {
        if (!customizations.has(f.key)) {
          customizations.set(f.key, { show: f.show, label: f.label, required: f.required });
        }
      }
    }
    for (const newType of Object.values(derived.message_types)) {
      for (const field of newType.fields) {
        const existing = customizations.get(field.key);
        if (!existing) continue;
        if (existing.show === false) field.show = false;
        if (existing.label !== field.label) field.label = existing.label;
        if (existing.required) field.required = existing.required;
      }
    }
  }

  // Only overwrite message_types if keys match
  const existingKeys = Object.keys(doc.message_types || {}).sort().join(",");
  const newKeys = Object.keys(derived.message_types).sort().join(",");
  if (!doc.message_types || existingKeys === newKeys) {
    await getDb()
      .collection<JsonClientEntry & { _id: string }>("clients")
      .updateOne({ _id: slug } as any, {
        $set: {
          message_types: derived.message_types,
          default_message_type: derived.default_message_type,
        },
      });
  }

  await loadClientsFromDb();
}

// ── GET /:agentId — View Node Structure ──────────────────────────────────────

nodeEditorRouter.get("/:agentId", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    // Pull latest from Retell
    const snapshot = await pullLatest(agentId);

    // Store in MongoDB
    await getDb()
      .collection<JsonClientEntry & { _id: string }>("clients")
      .updateOne({ _id: slug } as any, {
        $set: { [`retell_agents.${agentId}`]: snapshot.canonicalJson },
      });

    // Parse into structured representation
    const parsed = parseConversationFlow(snapshot.canonicalJson);
    const latestVersion = await getLatestVersion(slug, agentId);

    // Extract transition conditions from intro node edges
    const introEdges = parsed.introNode.raw.edges as Array<Record<string, unknown>> | undefined;
    const transitionConditions: Record<string, string> = {};
    if (Array.isArray(introEdges)) {
      for (const path of parsed.paths) {
        const edge = introEdges.find(
          (e) => e.destination_node_id === path.transitionNode.id,
        );
        if (edge) {
          const tc = edge.transition_condition as Record<string, unknown> | undefined;
          transitionConditions[path.name] = (tc?.prompt as string) ?? "";
        }
      }
    }

    // Extract FAQ knowledge base from FAQ node
    let faqKnowledgeBase = "";
    let faqNodeId: string | undefined;
    if (parsed.faqNode) {
      faqNodeId = parsed.faqNode.id;
      const instr = parsed.faqNode.raw.instruction as Record<string, unknown> | undefined;
      const fullText = (instr?.text as string) ?? "";
      // FAQ prompt format: "Your goal is to answer...\n\n{faqContent}"
      const faqPrefix = "Your goal is to answer administrative and general questions briefly and accurately.\n\n";
      faqKnowledgeBase = fullText.startsWith(faqPrefix)
        ? fullText.slice(faqPrefix.length)
        : fullText;
    }

    // Extract branch conditions from data points
    function extractBranchConditions(dp: typeof parsed.paths[0]["dataChain"][0]) {
      // Check the router edge for this data point's branch conditions
      const routerEdges = parsed.paths
        .flatMap((p) => {
          const re = p.routerNode.raw.edges as Array<Record<string, unknown>> | undefined;
          return (re ?? []).filter((e) => e.destination_node_id === dp.collectNode.id);
        });
      if (routerEdges.length === 0) return undefined;
      const edge = routerEdges[0];
      const tc = edge.transition_condition as Record<string, unknown> | undefined;
      if (tc?.type !== "equation") return undefined;
      const eqs = tc.equations as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(eqs)) return undefined;
      // Find branch condition equations (not the "is missing" checks)
      const branchEqs = eqs.filter((eq) => {
        const left = eq.left as string;
        // Skip the standard "is missing" equations for this variable
        if (left === `{{${dp.variableName}}}`) return false;
        if (left === `{{phone_number_collected}}`) return false;
        // Skip composite variable checks
        const isComposite = dp.variableDefs.some((v) => left === `{{${v.name}}}`);
        if (isComposite) return false;
        return true;
      });
      if (branchEqs.length === 0) return undefined;
      return branchEqs.map((eq) => ({
        variable: (eq.left as string).replace(/^\{\{|\}\}$/g, ""),
        operator: eq.operator as string,
        value: eq.right as string | undefined,
      }));
    }

    res.json({
      agentId,
      agentName: snapshot.agentName,
      conversationFlowId: snapshot.conversationFlowId,
      globalPrompt: parsed.globalPrompt,
      startNodeId: parsed.startNodeId,
      versionNumber: latestVersion?.version ?? 0,
      introNodeId: parsed.introNode.id,
      faqNodeId,
      faqKnowledgeBase,
      transitionConditions,
      paths: parsed.paths.map((p) => ({
        name: p.name,
        transitionNodeId: p.transitionNode.id,
        frontExtractNodeId: p.frontExtractNode.id,
        routerNodeId: p.routerNode.id,
        transitionCondition: transitionConditions[p.name] ?? "",
        dataPoints: p.dataChain.map((dp) => ({
          variableName: dp.variableName,
          label: dp.label,
          collectNodeId: dp.collectNode.id,
          confirmNodeId: dp.confirmNode.id,
          conversationPrompt: dp.conversationPrompt,
          forwardCondition: dp.forwardCondition,
          variableDefs: dp.variableDefs,
          branchConditions: extractBranchConditions(dp),
        })),
      })),
      nodes: parsed.allNodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        isGlobal: !!n.raw.global_node_setting,
        promptPreview:
          (n.raw.instruction as Record<string, unknown> | undefined)?.text
            ? String((n.raw.instruction as Record<string, unknown>).text).slice(0, 200)
            : undefined,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[node-editor] GET /${slug}/${agentId} error:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ── GET /:agentId/versions — List Version History ────────────────────────────

nodeEditorRouter.get("/:agentId/versions", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const offset = Number(req.query.offset) || 0;

  const result = await listVersions(slug, agentId, { limit, offset });
  res.json({
    versions: result.versions.map((v) => ({
      _id: v._id,
      version: v.version,
      source: v.source,
      description: v.description,
      createdBy: v.createdBy,
      createdAt: v.createdAt,
      nodeCount: v.nodeCount,
      dataPointCount: v.dataPointCount,
    })),
    total: result.total,
  });
});

// ── GET /:agentId/versions/:versionId — Get Specific Version ─────────────────

nodeEditorRouter.get("/:agentId/versions/:versionId", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const versionId = p.versionId;
  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    const version = await getVersion(versionId);
    if (!version || version.slug !== slug || version.agentId !== agentId) {
      res.status(404).json({ error: "Version not found" });
      return;
    }

    // Parse the version's canonical JSON for structured display
    const parsed = parseConversationFlow(version.canonicalJson);

    res.json({
      _id: version._id,
      version: version.version,
      source: version.source,
      description: version.description,
      createdBy: version.createdBy,
      createdAt: version.createdAt,
      nodeCount: version.nodeCount,
      dataPointCount: version.dataPointCount,
      globalPrompt: parsed.globalPrompt,
      paths: parsed.paths.map((p) => ({
        name: p.name,
        dataPoints: p.dataChain.map((dp) => ({
          variableName: dp.variableName,
          label: dp.label,
          conversationPrompt: dp.conversationPrompt,
        })),
      })),
      nodes: parsed.allNodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ── POST /:agentId/edit-prompt — Edit Node Prompt ────────────────────────────

nodeEditorRouter.post("/:agentId/edit-prompt", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const { nodeId, instruction } = req.body;

  if (!nodeId || typeof instruction !== "string" || instruction.trim().length === 0) {
    res.status(400).json({ error: "nodeId and instruction (non-empty string) are required" });
    return;
  }

  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    // Pull latest from Retell
    const snapshot = await pullLatest(agentId);
    const canonical = snapshot.canonicalJson;
    const flow = canonical.conversationFlow as Record<string, unknown>;
    const nodes = flow.nodes as Array<Record<string, unknown>>;

    // Find the target node
    const targetNode = nodes.find((n) => n.id === nodeId);
    if (!targetNode) {
      res.status(404).json({ error: `Node "${nodeId}" not found` });
      return;
    }
    if (targetNode.type !== "conversation") {
      res.status(400).json({ error: "Can only edit prompt on conversation nodes" });
      return;
    }

    // Snapshot before edit
    await createVersionSnapshot(
      slug, agentId, canonical, "manual_edit",
      `Edit prompt on node "${targetNode.name}"`,
      req.user?.username ?? "unknown",
    );

    // Apply edit
    const existingInstruction = targetNode.instruction as Record<string, unknown>;
    existingInstruction.text = instruction;

    // Validate
    const errors = validateConversationFlow(flow);
    if (errors.length > 0) {
      res.status(400).json({ error: "Validation failed", errors });
      return;
    }

    // Push to Retell
    await pushFlowToRetell(retell(), snapshot.conversationFlowId, canonical);

    // Store in MongoDB
    await storeCanonical(slug, agentId, canonical, resolved.doc);

    await logAudit(req, "edit_node_prompt", `${slug}/${agentId}`, { nodeId, nodeName: targetNode.name });
    res.json({ success: true, nodeId, nodeName: targetNode.name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[node-editor] edit-prompt error:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /:agentId/edit-global-prompt — Edit Global Prompt ───────────────────

nodeEditorRouter.post("/:agentId/edit-global-prompt", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const { globalPrompt } = req.body;

  if (typeof globalPrompt !== "string" || globalPrompt.trim().length === 0) {
    res.status(400).json({ error: "globalPrompt (non-empty string) is required" });
    return;
  }

  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    const snapshot = await pullLatest(agentId);
    const canonical = snapshot.canonicalJson;
    const flow = canonical.conversationFlow as Record<string, unknown>;

    // Snapshot before edit
    await createVersionSnapshot(
      slug, agentId, canonical, "manual_edit",
      "Edit global prompt",
      req.user?.username ?? "unknown",
    );

    // Apply edit
    flow.global_prompt = globalPrompt;

    // Validate
    const errors = validateConversationFlow(flow);
    if (errors.length > 0) {
      res.status(400).json({ error: "Validation failed", errors });
      return;
    }

    // Push to Retell
    await pushFlowToRetell(retell(), snapshot.conversationFlowId, canonical);
    await storeCanonical(slug, agentId, canonical, resolved.doc);

    await logAudit(req, "edit_global_prompt", `${slug}/${agentId}`);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[node-editor] edit-global-prompt error:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /:agentId/edit-transition — Edit Path Transition Condition ──────────

nodeEditorRouter.post("/:agentId/edit-transition", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const { pathName, transitionCondition } = req.body;

  if (!pathName || typeof pathName !== "string") {
    res.status(400).json({ error: "pathName (string) is required" });
    return;
  }
  if (typeof transitionCondition !== "string" || transitionCondition.trim().length === 0) {
    res.status(400).json({ error: "transitionCondition (non-empty string) is required" });
    return;
  }

  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    const snapshot = await pullLatest(agentId);
    const canonical = snapshot.canonicalJson;
    const parsed = parseConversationFlow(canonical);

    // Find the target path's transition node
    const targetPath = parsed.paths.find((pa) => pa.name === pathName);
    if (!targetPath) {
      res.status(404).json({
        error: `Path "${pathName}" not found`,
        availablePaths: parsed.paths.map((pa) => pa.name),
      });
      return;
    }

    // Find the intro node edge that points to this path's transition node
    const introNode = parsed.introNode.raw;
    const edges = introNode.edges as Array<Record<string, unknown>>;
    const targetEdge = edges.find(
      (e) => e.destination_node_id === targetPath.transitionNode.id,
    );
    if (!targetEdge) {
      res.status(500).json({ error: "Could not find transition edge for this path" });
      return;
    }

    // Snapshot before edit
    await createVersionSnapshot(
      slug, agentId, canonical, "manual_edit",
      `Edit transition condition for path "${pathName}"`,
      req.user?.username ?? "unknown",
    );

    // Update the edge's transition condition
    (targetEdge.transition_condition as Record<string, unknown>).prompt = transitionCondition;

    // Validate
    const flow = canonical.conversationFlow as Record<string, unknown>;
    const errors = validateConversationFlow(flow);
    if (errors.length > 0) {
      res.status(400).json({ error: "Validation failed", errors });
      return;
    }

    // Push to Retell
    await pushFlowToRetell(retell(), snapshot.conversationFlowId, canonical);
    await storeCanonical(slug, agentId, canonical, resolved.doc);

    await logAudit(req, "edit_transition", `${slug}/${agentId}`, { pathName, transitionCondition });
    res.json({ success: true, pathName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[node-editor] edit-transition error:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /:agentId/edit-agent-settings — Edit Agent-Level Settings ───────────

nodeEditorRouter.post("/:agentId/edit-agent-settings", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;

  const ALLOWED_SETTINGS = new Set([
    "agent_name", "voice_id", "voice_speed", "voice_temperature",
    "volume", "enable_backchannel", "backchannel_frequency",
    "interruption_sensitivity", "ambient_sound", "ambient_sound_volume",
    "responsiveness", "begin_message_delay_ms", "reminder_trigger_ms",
    "reminder_max_count", "end_call_after_silence_ms", "max_call_duration_ms",
    "language", "webhook_url",
  ]);

  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.body)) {
    if (ALLOWED_SETTINGS.has(key)) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid settings provided", allowed: [...ALLOWED_SETTINGS] });
    return;
  }

  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    // Snapshot current state
    const snapshot = await pullLatest(agentId);
    await createVersionSnapshot(
      slug, agentId, snapshot.canonicalJson, "manual_edit",
      `Edit agent settings: ${Object.keys(updates).join(", ")}`,
      req.user?.username ?? "unknown",
    );

    // Push agent-level updates to Retell
    await retell().agent.update(agentId, updates as any);

    // Fetch fresh state and store
    const fresh = await pullLatest(agentId);
    await storeCanonical(slug, agentId, fresh.canonicalJson, resolved.doc);

    await logAudit(req, "edit_agent_settings", `${slug}/${agentId}`, { fields: Object.keys(updates) });
    res.json({ success: true, updated: Object.keys(updates) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[node-editor] edit-agent-settings error:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /:agentId/rollback — Restore From Version Snapshot ──────────────────

nodeEditorRouter.post("/:agentId/rollback", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const versionId = req.body.versionId as string | undefined;

  if (!versionId) {
    res.status(400).json({ error: "versionId is required" });
    return;
  }

  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    // Get the version to restore
    const version = await getVersion(versionId);
    if (!version || version.slug !== slug || version.agentId !== agentId) {
      res.status(404).json({ error: "Version not found" });
      return;
    }

    // Pull current state and snapshot it
    const currentSnapshot = await pullLatest(agentId);
    await createVersionSnapshot(
      slug, agentId, currentSnapshot.canonicalJson, "rollback",
      `Pre-rollback snapshot (before restoring version ${version.version})`,
      req.user?.username ?? "unknown",
    );

    // Validate the old version
    const oldFlow = version.canonicalJson.conversationFlow as Record<string, unknown>;
    if (!oldFlow) {
      res.status(400).json({ error: "Version has no conversationFlow" });
      return;
    }
    const errors = validateConversationFlow(oldFlow);
    if (errors.length > 0) {
      res.status(400).json({ error: "Version failed validation", errors });
      return;
    }

    // Push old version to Retell
    await pushFlowToRetell(retell(), currentSnapshot.conversationFlowId, version.canonicalJson);

    // Check if agent-level settings differ
    const oldAgent = version.canonicalJson;
    const currentAgent = currentSnapshot.canonicalJson;
    const agentUpdates: Record<string, unknown> = {};
    for (const key of ["agent_name", "voice_id", "voice_speed", "voice_temperature", "volume"]) {
      if (oldAgent[key] !== undefined && oldAgent[key] !== currentAgent[key]) {
        agentUpdates[key] = oldAgent[key];
      }
    }
    if (Object.keys(agentUpdates).length > 0) {
      await retell().agent.update(agentId, agentUpdates as any);
    }

    // Fetch fresh state and store
    const fresh = await pullLatest(agentId);
    await storeCanonical(slug, agentId, fresh.canonicalJson, resolved.doc);

    // Snapshot the restored state
    await createVersionSnapshot(
      slug, agentId, fresh.canonicalJson, "rollback",
      `Restored from version ${version.version}`,
      req.user?.username ?? "unknown",
    );

    await logAudit(req, "rollback_agent", `${slug}/${agentId}`, {
      restoredVersion: version.version,
      versionId,
    });

    res.json({
      success: true,
      restoredVersion: version.version,
      agentSettingsUpdated: Object.keys(agentUpdates),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[node-editor] rollback error:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /:agentId/add-data-point — Add Data Collection Question ─────────────

nodeEditorRouter.post("/:agentId/add-data-point", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const { dataPointKey, pathName, position } = req.body;

  if (!dataPointKey || typeof dataPointKey !== "string") {
    res.status(400).json({ error: "dataPointKey (string) is required" });
    return;
  }

  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    // Resolve data point from defaults
    const defaults = await getDataPointDefaults();
    let newDp: DataPoint;
    try {
      const resolved_dps = resolveDataPoints([dataPointKey], defaults);
      newDp = resolved_dps[0];
    } catch {
      res.status(400).json({ error: `Unknown data point key "${dataPointKey}"` });
      return;
    }

    // Pull latest and parse
    const snapshot = await pullLatest(agentId);
    const canonical = snapshot.canonicalJson;
    const parsed = parseConversationFlow(canonical);

    // Find target path
    const targetPath = findPath(parsed.paths, pathName);
    if (!targetPath) {
      res.status(404).json({
        error: pathName
          ? `Path "${pathName}" not found`
          : "No path found in agent",
        availablePaths: parsed.paths.map((p) => p.name),
      });
      return;
    }

    // Check if variable already exists
    const existingVars = targetPath.dataChain.map((dp) => dp.variableName);
    if (existingVars.includes(newDp.variableName)) {
      res.status(400).json({
        error: `Variable "${newDp.variableName}" already exists in path "${targetPath.name}"`,
      });
      return;
    }

    // Build updated data points list
    const currentDataPoints = buildDataPointsFromChain(targetPath, defaults);
    const insertAt = typeof position === "number"
      ? Math.min(Math.max(0, position), currentDataPoints.length)
      : currentDataPoints.length;
    currentDataPoints.splice(insertAt, 0, newDp);

    // Snapshot before edit
    await createVersionSnapshot(
      slug, agentId, canonical, "manual_edit",
      `Add data point "${newDp.label}" to path "${targetPath.name}" at position ${insertAt}`,
      req.user?.username ?? "unknown",
    );

    // Find close node
    const closeNodeId = parsed.closeNode?.id;
    if (!closeNodeId) {
      res.status(500).json({ error: "Could not find Close node in flow" });
      return;
    }

    // Regenerate chain
    const result = regenerateDataChain(
      targetPath,
      currentDataPoints,
      closeNodeId,
      targetPath.name === "Default" ? undefined : targetPath.name,
    );
    applyRegeneratedChain(canonical, result);

    // Validate
    const flow = canonical.conversationFlow as Record<string, unknown>;
    const errors = validateConversationFlow(flow);
    if (errors.length > 0) {
      res.status(400).json({ error: "Validation failed after regeneration", errors });
      return;
    }

    // Push to Retell
    await pushFlowToRetell(retell(), snapshot.conversationFlowId, canonical);
    await storeCanonical(slug, agentId, canonical, resolved.doc);

    await logAudit(req, "add_data_point", `${slug}/${agentId}`, {
      dataPointKey,
      pathName: targetPath.name,
      position: insertAt,
    });
    res.json({
      success: true,
      variableName: newDp.variableName,
      label: newDp.label,
      position: insertAt,
      pathName: targetPath.name,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[node-editor] add-data-point error:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /:agentId/remove-data-point — Remove Data Collection Question ──────

nodeEditorRouter.post("/:agentId/remove-data-point", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const { variableName, pathName } = req.body;

  if (!variableName || typeof variableName !== "string") {
    res.status(400).json({ error: "variableName (string) is required" });
    return;
  }

  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    const defaults = await getDataPointDefaults();
    const snapshot = await pullLatest(agentId);
    const canonical = snapshot.canonicalJson;
    const parsed = parseConversationFlow(canonical);

    const targetPath = findPath(parsed.paths, pathName);
    if (!targetPath) {
      res.status(404).json({ error: pathName ? `Path "${pathName}" not found` : "No path found" });
      return;
    }

    const existingVars = targetPath.dataChain.map((dp) => dp.variableName);
    if (!existingVars.includes(variableName)) {
      res.status(404).json({
        error: `Variable "${variableName}" not found in path "${targetPath.name}"`,
        existingVariables: existingVars,
      });
      return;
    }

    if (existingVars.length <= 1) {
      res.status(400).json({ error: "Cannot remove the last data point from a path" });
      return;
    }

    // Build updated data points list without the removed one
    const currentDataPoints = buildDataPointsFromChain(targetPath, defaults);
    const filtered = currentDataPoints.filter((dp) => dp.variableName !== variableName);

    // Snapshot
    await createVersionSnapshot(
      slug, agentId, canonical, "manual_edit",
      `Remove data point "${variableName}" from path "${targetPath.name}"`,
      req.user?.username ?? "unknown",
    );

    const closeNodeId = parsed.closeNode?.id;
    if (!closeNodeId) {
      res.status(500).json({ error: "Could not find Close node" });
      return;
    }

    const result = regenerateDataChain(
      targetPath,
      filtered,
      closeNodeId,
      targetPath.name === "Default" ? undefined : targetPath.name,
    );
    applyRegeneratedChain(canonical, result);

    const flow = canonical.conversationFlow as Record<string, unknown>;
    const errors = validateConversationFlow(flow);
    if (errors.length > 0) {
      res.status(400).json({ error: "Validation failed after regeneration", errors });
      return;
    }

    await pushFlowToRetell(retell(), snapshot.conversationFlowId, canonical);
    await storeCanonical(slug, agentId, canonical, resolved.doc);

    await logAudit(req, "remove_data_point", `${slug}/${agentId}`, {
      variableName,
      pathName: targetPath.name,
    });
    res.json({ success: true, variableName, pathName: targetPath.name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[node-editor] remove-data-point error:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /:agentId/reorder-data-points — Reorder Questions ──────────────────

nodeEditorRouter.post("/:agentId/reorder-data-points", async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const { variableNames, pathName } = req.body;

  if (!Array.isArray(variableNames) || variableNames.length === 0) {
    res.status(400).json({ error: "variableNames (non-empty string array) is required" });
    return;
  }

  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    const defaults = await getDataPointDefaults();
    const snapshot = await pullLatest(agentId);
    const canonical = snapshot.canonicalJson;
    const parsed = parseConversationFlow(canonical);

    const targetPath = findPath(parsed.paths, pathName);
    if (!targetPath) {
      res.status(404).json({ error: pathName ? `Path "${pathName}" not found` : "No path found" });
      return;
    }

    // Validate that the variable names match
    const existingVars = new Set(targetPath.dataChain.map((dp) => dp.variableName));
    const providedVars = new Set(variableNames as string[]);
    const missing = [...existingVars].filter((v) => !providedVars.has(v));
    const extra = [...providedVars].filter((v) => !existingVars.has(v));

    if (missing.length > 0 || extra.length > 0) {
      res.status(400).json({
        error: "variableNames must contain exactly the same variables as the current path",
        missing,
        extra,
      });
      return;
    }

    // Build reordered data points list
    const currentDataPoints = buildDataPointsFromChain(targetPath, defaults);
    const dpMap = new Map(currentDataPoints.map((dp) => [dp.variableName, dp]));
    const reordered = (variableNames as string[]).map((name) => dpMap.get(name)!);

    // Snapshot
    await createVersionSnapshot(
      slug, agentId, canonical, "manual_edit",
      `Reorder data points in path "${targetPath.name}"`,
      req.user?.username ?? "unknown",
    );

    const closeNodeId = parsed.closeNode?.id;
    if (!closeNodeId) {
      res.status(500).json({ error: "Could not find Close node" });
      return;
    }

    const result = regenerateDataChain(
      targetPath,
      reordered,
      closeNodeId,
      targetPath.name === "Default" ? undefined : targetPath.name,
    );
    applyRegeneratedChain(canonical, result);

    const flow = canonical.conversationFlow as Record<string, unknown>;
    const errors = validateConversationFlow(flow);
    if (errors.length > 0) {
      res.status(400).json({ error: "Validation failed after regeneration", errors });
      return;
    }

    await pushFlowToRetell(retell(), snapshot.conversationFlowId, canonical);
    await storeCanonical(slug, agentId, canonical, resolved.doc);

    await logAudit(req, "reorder_data_points", `${slug}/${agentId}`, {
      variableNames,
      pathName: targetPath.name,
    });
    res.json({ success: true, variableNames, pathName: targetPath.name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[node-editor] reorder-data-points error:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ── Shared Helpers for Structural Editing ────────────────────────────────────

import type { ParsedPath, ParsedFlow } from "../../lib/node-parser.js";

function findPath(
  paths: ParsedPath[],
  pathName?: string,
): ParsedPath | undefined {
  if (!pathName) return paths[0];
  return paths.find((p) => p.name === pathName);
}

/**
 * Reconstructs DataPoint[] from a parsed path's data chain.
 * Uses the confirm node's variables and collect node's prompts.
 */
function buildDataPointsFromChain(
  path: ParsedPath,
  defaults: Record<string, DataPoint>,
): DataPoint[] {
  return path.dataChain.map((dp) => {
    // Try to find the default definition first
    const defaultDp = defaults[dp.variableName];

    // Build from what we have in the existing nodes
    const varDef = dp.variableDefs[0];
    const result: DataPoint = {
      label: dp.label,
      variableName: dp.variableName,
      type: (varDef?.type as DataPoint["type"]) ?? "string",
      choices: varDef?.choices ?? [],
      description: varDef?.description ?? "",
      conversationPrompt: dp.conversationPrompt,
      forwardCondition: dp.forwardCondition,
      finetuneExamples: [],
      extractSuccessEquation: defaultDp?.extractSuccessEquation ?? [
        { left: `{{${dp.variableName}}}`, operator: "exists" },
        { left: `{{${dp.variableName}}}`, operator: "!=", right: "Not Mentioned" },
      ],
    };

    // For composite data points: the collect node name == label (no "Collect " prefix)
    const isComposite = !dp.collectNode.name.startsWith("Collect ");
    if (isComposite && dp.variableDefs.length > 1) {
      result.composite = true;
      result.variables = dp.variableDefs.map((v) => ({
        variableName: v.name,
        type: v.type as "string" | "enum" | "boolean",
        choices: v.choices,
        description: v.description,
      }));
    }

    return result;
  });
}

// ── POST /:agentId/push — Raw JSON Push (admin/root only) ───────────────────

nodeEditorRouter.post("/:agentId/push", requireRoot, async (req, res) => {
  const p = req.params as Record<string, string>;
  const slug = p.slug;
  const agentId = p.agentId;
  const canonicalJson = req.body.canonicalJson as Record<string, unknown> | undefined;
  const description = req.body.description as string | undefined;

  if (!canonicalJson || typeof canonicalJson !== "object") {
    res.status(400).json({ error: "canonicalJson object is required" });
    return;
  }

  const resolved = await resolveAgentId(slug, agentId);
  if (!resolved) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  try {
    // Validate
    const flow = canonicalJson.conversationFlow as Record<string, unknown>;
    if (!flow) {
      res.status(400).json({ error: "canonicalJson must contain conversationFlow" });
      return;
    }
    const errors = validateConversationFlow(flow);
    if (errors.length > 0) {
      res.status(400).json({ error: "Validation failed", errors });
      return;
    }

    // Snapshot current state
    const currentSnapshot = await pullLatest(agentId);
    await createVersionSnapshot(
      slug, agentId, currentSnapshot.canonicalJson, "manual_edit",
      `Pre-push snapshot (before raw JSON push)`,
      req.user?.username ?? "unknown",
    );

    // Push to Retell
    await pushFlowToRetell(retell(), currentSnapshot.conversationFlowId, canonicalJson);

    // Fetch fresh state and store
    const fresh = await pullLatest(agentId);
    await storeCanonical(slug, agentId, fresh.canonicalJson, resolved.doc);

    await createVersionSnapshot(
      slug, agentId, fresh.canonicalJson, "manual_edit",
      description || "Raw JSON push",
      req.user?.username ?? "unknown",
    );

    await logAudit(req, "push_raw_json", `${slug}/${agentId}`, { description });
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[node-editor] push error:`, msg);
    res.status(500).json({ error: msg });
  }
});
