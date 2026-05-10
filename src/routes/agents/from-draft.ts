import type { Request, Response } from "express";
import {
  createAgentFromConfig,
  type CreateAgentBody,
} from "../../lib/agent-from-config.js";
import {
  loadDraft,
  applyOverrides,
} from "../../lib/agent-from-draft.js";

interface FromDraftRequest {
  draft: string;
  business: {
    businessName: string;
    faqKnowledgeBase: string;
  };
  client?: Partial<CreateAgentBody["client"]>;
}

export async function createFromDraftHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as FromDraftRequest;

  if (!body?.draft || typeof body.draft !== "string") {
    res.status(400).json({ error: "Missing required field: draft (draft name)" });
    return;
  }
  if (!body.business?.businessName || !body.business?.faqKnowledgeBase) {
    res.status(400).json({ error: "Missing required field: business.businessName and business.faqKnowledgeBase" });
    return;
  }

  const draft = await loadDraft(body.draft);
  if (!draft) {
    res.status(404).json({ error: `Draft "${body.draft}" not found` });
    return;
  }
  if (!draft.exportConfig) {
    res.status(400).json({
      error: `Draft "${body.draft}" lacks programmatic config`,
      details: "Open the draft in the agent form and click 'Save Draft' once to migrate it. This adds the canonical config alongside the form state.",
    });
    return;
  }

  console.log(
    `[from-draft] instantiating "${body.draft}" → "${body.business.businessName}"`,
  );

  // Stamp lineage onto the new client doc:
  //   - source_draft: always — lets transcript-review and Phase 3 propagation
  //     find sibling agents built from the same draft.
  //   - transcript_review_enabled: only when the draft is `is_template` AND
  //     the caller didn't explicitly pass a value. Operator-set value wins.
  const lineageOverrides: Partial<CreateAgentBody["client"]> = {
    source_draft: draft.name,
  };
  if (draft.is_template && body.client?.transcript_review_enabled === undefined) {
    lineageOverrides.transcript_review_enabled = true;
  }

  const fullBody = applyOverrides(draft.exportConfig, {
    business: body.business,
    client: { ...lineageOverrides, ...(body.client ?? {}) },
  });

  const result = await createAgentFromConfig(fullBody);

  if (result.ok) {
    res.status(201).json({
      success: true,
      draft: body.draft,
      slug: result.slug,
      agent_id: result.agentId,
      conversation_flow_id: result.conversationFlowId,
      notification_config: result.notificationConfig,
      provisioned_number: result.provisionedNumber,
      provision_error: result.provisionError,
    });
    return;
  }

  const errBody: { error: string; details?: string } = { error: result.error };
  if (result.details !== undefined) errBody.details = result.details;
  res.status(result.status).json(errBody);
}
