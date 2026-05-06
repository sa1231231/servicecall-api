import { createAgentFromConfig, } from "../../lib/agent-from-config.js";
import { loadTemplate, applyOverrides, } from "../../lib/agent-from-template.js";
export async function createFromTemplateHandler(req, res) {
    const body = req.body;
    if (!body?.template || typeof body.template !== "string") {
        res.status(400).json({ error: "Missing required field: template (template name)" });
        return;
    }
    if (!body.business?.businessName || !body.business?.faqKnowledgeBase) {
        res.status(400).json({ error: "Missing required field: business.businessName and business.faqKnowledgeBase" });
        return;
    }
    const template = await loadTemplate(body.template);
    if (!template) {
        res.status(404).json({ error: `Template "${body.template}" not found` });
        return;
    }
    if (!template.exportConfig) {
        res.status(400).json({
            error: `Template "${body.template}" lacks programmatic config`,
            details: "Open the template in the agent form and click 'Save as Template' once to migrate it. This adds the canonical config alongside the form state.",
        });
        return;
    }
    console.log(`[from-template] instantiating "${body.template}" → "${body.business.businessName}"`);
    const fullBody = applyOverrides(template.exportConfig, {
        business: body.business,
        client: body.client,
    });
    const result = await createAgentFromConfig(fullBody);
    if (result.ok) {
        res.status(201).json({
            success: true,
            template: body.template,
            slug: result.slug,
            agent_id: result.agentId,
            conversation_flow_id: result.conversationFlowId,
            notification_config: result.notificationConfig,
            provisioned_number: result.provisionedNumber,
            provision_error: result.provisionError,
        });
        return;
    }
    const errBody = { error: result.error };
    if (result.details !== undefined)
        errBody.details = result.details;
    res.status(result.status).json(errBody);
}
