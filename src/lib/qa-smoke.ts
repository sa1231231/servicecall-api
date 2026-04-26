import type Retell from "retell-sdk";
import { fetchRetellAgent, extractVariables, type RetellAgentSnapshot } from "./retell-sync.js";
import type { JsonClientEntry } from "../config/client-store.js";
import { ruleToFunction } from "../config/client-store.js";
import { config } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  check: string;
  status: CheckStatus;
  message: string;
}

export interface SmokeReport {
  slug: string;
  agent_id: string;
  timestamp: string;
  duration_ms: number;
  overall: "pass" | "fail";
  summary: { total: number; pass: number; fail: number; warn: number; skip: number };
  checks: CheckResult[];
}

export interface SmokeTestOptions {
  notify?: boolean;
  postHookUrl?: string;
}

// ── Synthetic variable generation ────────────────────────────────────────────

const SYNTHETIC_VALUES: Record<string, string> = {
  full_name: "QA Smoke Test",
  phone_number: "555-000-0000",
  email: "qa-smoke@test.local",
  street_address: "123 Test St",
  city: "Testville",
  company_name: "Test Company Inc",
  problem_description: "QA smoke test — not a real call",
  preferred_day: "Monday",
  preferred_time: "Morning",
  truck_number: "T-0000",
  driver_name: "QA Driver",
  driver_phone: "555-000-0001",
  breakdown_location: "123 Test Rd, Testville",
  vehicle_type: "Box truck",
  vehicle_manufacturer: "Test Motors",
  vehicle_color: "White",
  whos_paying: "Company",
  payment_method: "Credit card",
  is_emergency: "false",
};

export function buildSyntheticVariables(
  clientDoc: JsonClientEntry,
): Record<string, string> {
  const vars: Record<string, string> = {};

  // Collect all field keys across all message types
  for (const mt of Object.values(clientDoc.message_types)) {
    for (const field of mt.fields) {
      vars[field.key] = SYNTHETIC_VALUES[field.key] ?? "test_value";
    }
  }

  // Set resolve rule fields to trigger the default path
  if (clientDoc.resolve_rule) {
    // Binary rule: set to the "else" value (non-emergency default)
    vars[clientDoc.resolve_rule.field] =
      clientDoc.resolve_rule.field === "is_emergency" ? "false" : clientDoc.resolve_rule.equals;
  }
  if (clientDoc.resolve_rules && clientDoc.resolve_rules.length > 0) {
    // Multi-path: trigger the first rule
    const first = clientDoc.resolve_rules[0];
    vars[first.field] = first.equals;
  }

  return vars;
}

// ── Check functions (pure, exported for testing) ─────────────────────────────

export function checkGreetingBusinessName(
  snapshot: RetellAgentSnapshot,
  clientDoc: JsonClientEntry,
): CheckResult {
  const name = clientDoc.name;

  const flow = snapshot.canonicalJson.conversationFlow as Record<string, unknown> | undefined;
  if (!flow) {
    return { check: "greeting_has_business_name", status: "fail", message: "No conversation flow found in agent" };
  }

  const globalPrompt = (flow.global_prompt as string) ?? "";
  const nodes = (flow.nodes as Array<Record<string, unknown>>) ?? [];
  const startNodeId = flow.start_node_id as string;

  // Find intro node
  const introNode = nodes.find((n) => n.id === startNodeId);
  const introInstruction = extractInstructionText(introNode);

  const combined = globalPrompt + "\n" + introInstruction;

  // Check that every significant word from the business name appears in the text
  const nameWords = name
    .toLowerCase()
    .split(/[\s&,.\-\/]+/)
    .filter((w) => w.length >= 2);

  const containsName = (text: string): boolean => {
    const lower = text.toLowerCase();
    return nameWords.every((w) => lower.includes(w));
  };

  // 1. Direct match: name words appear literally in prompts
  const inGlobal = containsName(globalPrompt);
  const inIntro = containsName(introInstruction);

  if (inGlobal || inIntro) {
    const where = inGlobal && inIntro ? "global prompt and intro node"
      : inGlobal ? "global prompt" : "intro node";
    return { check: "greeting_has_business_name", status: "pass", message: `Found '${name}' in ${where}` };
  }

  // 2. Variable reference: prompt uses a {{variable}} that holds the business name
  const varRefPattern = /\{\{(\w*(?:business|company|client)[\w]*)\}\}/gi;
  const varRefs = combined.match(varRefPattern);
  if (varRefs && varRefs.length > 0) {
    const varNames = varRefs.map((r) => r.replace(/[{}]/g, ""));
    return { check: "greeting_has_business_name", status: "pass", message: `Business name injected via variable {{${varNames[0]}}}` };
  }

  return { check: "greeting_has_business_name", status: "fail", message: `Business name '${name}' not found in global prompt or intro node` };
}

export function checkDataPointsInFlow(
  snapshot: RetellAgentSnapshot,
  clientDoc: JsonClientEntry,
): CheckResult {
  const flowVarKeys = new Set(snapshot.variables.map((v) => v.key));

  const allFieldKeys = new Set<string>();
  for (const mt of Object.values(clientDoc.message_types)) {
    for (const field of mt.fields) {
      allFieldKeys.add(field.key);
    }
  }

  const missing = [...allFieldKeys].filter((k) => !flowVarKeys.has(k));

  if (missing.length === 0) {
    return { check: "data_points_in_flow", status: "pass", message: `All ${allFieldKeys.size} notification fields found in flow variables` };
  }

  return { check: "data_points_in_flow", status: "fail", message: `Missing flow variables for notification fields: ${missing.join(", ")}` };
}

export function checkNotificationConfigComplete(
  clientDoc: JsonClientEntry,
): CheckResult {
  const issues: string[] = [];

  const typeKeys = Object.keys(clientDoc.message_types);
  if (typeKeys.length === 0) {
    issues.push("no message_types configured");
  }

  if (!clientDoc.message_types[clientDoc.default_message_type]) {
    issues.push(`default_message_type '${clientDoc.default_message_type}' not found in message_types`);
  }

  const hasSms = clientDoc.dispatch_text_numbers.length > 0;
  const hasEmail = clientDoc.dispatch_email && clientDoc.dispatch_email.length > 0;
  if (!hasSms && !hasEmail) {
    issues.push("no dispatch channels configured (no SMS numbers or emails)");
  }

  if (issues.length > 0) {
    return { check: "notification_config_complete", status: "fail", message: issues.join("; ") };
  }

  const smsCount = clientDoc.dispatch_text_numbers.length;
  const emailCount = clientDoc.dispatch_email?.length ?? 0;
  return { check: "notification_config_complete", status: "pass", message: `${smsCount} SMS number(s), ${emailCount} email(s) configured` };
}

export function checkMessageTypeResolves(
  clientDoc: JsonClientEntry,
): CheckResult {
  const resolveType = ruleToFunction(
    clientDoc.resolve_rule,
    clientDoc.resolve_rules,
    clientDoc.default_message_type,
  );

  const syntheticVars = buildSyntheticVariables(clientDoc);
  const resolved = resolveType(syntheticVars);

  if (!clientDoc.message_types[resolved]) {
    return { check: "message_type_resolves", status: "fail", message: `Resolved to '${resolved}' which is not a valid message_type key` };
  }

  // Also test with empty vars (fallback path)
  const fallback = resolveType({});
  if (!clientDoc.message_types[fallback]) {
    return { check: "message_type_resolves", status: "warn", message: `Resolves to '${resolved}' (valid), but empty-vars fallback '${fallback}' is not a valid key` };
  }

  return { check: "message_type_resolves", status: "pass", message: `Resolves to '${resolved}' (valid)` };
}

export function checkRequiredFieldsSatisfiable(
  snapshot: RetellAgentSnapshot,
  clientDoc: JsonClientEntry,
): CheckResult {
  const flowVarKeys = new Set(snapshot.variables.map((v) => v.key));

  const unsatisfiable: string[] = [];
  for (const mt of Object.values(clientDoc.message_types)) {
    for (const field of mt.fields) {
      if (field.required && !flowVarKeys.has(field.key)) {
        unsatisfiable.push(field.key);
      }
    }
  }

  if (unsatisfiable.length === 0) {
    const requiredCount = Object.values(clientDoc.message_types)
      .flatMap((mt) => mt.fields)
      .filter((f) => f.required).length;
    return { check: "required_fields_satisfiable", status: "pass", message: `All ${requiredCount} required field(s) are collectible` };
  }

  return { check: "required_fields_satisfiable", status: "fail", message: `Required fields not in flow variables: ${[...new Set(unsatisfiable)].join(", ")}` };
}

// ── Tier 2: Notification simulation ──────────────────────────────────────────

async function checkNotificationFires(
  clientDoc: JsonClientEntry & { _id: string },
  agentId: string,
  options: SmokeTestOptions,
): Promise<CheckResult> {
  if (!clientDoc.shadow_mode) {
    return { check: "notification_fires", status: "fail", message: "Client must have shadow_mode enabled for notification simulation" };
  }

  const postHookUrl = options.postHookUrl ?? `http://localhost:${config.PORT}/retell/post-hook`;
  const syntheticVars = buildSyntheticVariables(clientDoc);

  const payload = {
    event: "call_ended",
    call: {
      call_id: `qa-smoke-${Date.now()}`,
      agent_id: agentId,
      from_number: "+15550000000",
      duration_ms: 30000,
      disconnection_reason: "agent_hangup",
      collected_dynamic_variables: syntheticVars,
      retell_llm_dynamic_variables: {},
    },
  };

  try {
    const resp = await fetch(postHookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const body = await resp.json() as Record<string, unknown>;

    if (resp.ok && body.outcome === "shadow_dry_run") {
      return { check: "notification_fires", status: "pass", message: "Shadow notification dispatched successfully" };
    }

    return { check: "notification_fires", status: "fail", message: `Post-hook returned: ${JSON.stringify(body)}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { check: "notification_fires", status: "fail", message: `Failed to reach post-hook: ${msg}` };
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runSmokeTest(
  retell: Retell,
  clientDoc: JsonClientEntry & { _id: string },
  options: SmokeTestOptions = {},
): Promise<SmokeReport> {
  const start = Date.now();
  const slug = clientDoc._id;
  const agentId = clientDoc.agent_ids[0] ?? "";
  const checks: CheckResult[] = [];

  // 1. Agent config present — prefer canonical JSON from MongoDB, fall back to live Retell API
  let snapshot: RetellAgentSnapshot | null = null;
  const storedJson = clientDoc.retell_agents?.[agentId];
  if (storedJson) {
    const variables = extractVariables(storedJson);
    const agentName = (storedJson.agent_name as string) ?? clientDoc.name;
    snapshot = {
      agentId,
      agentName,
      conversationFlowId: "",
      variables,
      canonicalJson: storedJson,
    };
    checks.push({ check: "agent_reachable", status: "pass", message: `Agent '${agentName}' loaded from config` });
  } else {
    try {
      snapshot = await fetchRetellAgent(retell, agentId);
      checks.push({ check: "agent_reachable", status: "pass", message: `Agent '${snapshot.agentName}' retrieved from Retell (not yet synced)` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({ check: "agent_reachable", status: "fail", message: `Cannot reach agent '${agentId}': ${msg}` });
    }
  }

  // Checks 2-6 require the snapshot
  if (snapshot) {
    checks.push(checkGreetingBusinessName(snapshot, clientDoc));
    checks.push(checkDataPointsInFlow(snapshot, clientDoc));
    checks.push(checkNotificationConfigComplete(clientDoc));
    checks.push(checkMessageTypeResolves(clientDoc));
    checks.push(checkRequiredFieldsSatisfiable(snapshot, clientDoc));
  } else {
    const skipped = ["greeting_has_business_name", "data_points_in_flow", "notification_config_complete", "message_type_resolves", "required_fields_satisfiable"];
    for (const name of skipped) {
      checks.push({ check: name, status: "skip", message: "Skipped — agent not reachable" });
    }
  }

  // 7. Tier 2: notification simulation
  if (options.notify) {
    checks.push(await checkNotificationFires(clientDoc, agentId, options));
  }

  const summary = {
    total: checks.length,
    pass: checks.filter((c) => c.status === "pass").length,
    fail: checks.filter((c) => c.status === "fail").length,
    warn: checks.filter((c) => c.status === "warn").length,
    skip: checks.filter((c) => c.status === "skip").length,
  };

  return {
    slug,
    agent_id: agentId,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - start,
    overall: summary.fail > 0 ? "fail" : "pass",
    summary,
    checks,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractInstructionText(node: Record<string, unknown> | undefined): string {
  if (!node) return "";
  const raw = node.instruction;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null) {
    return (raw as Record<string, unknown>).text as string ?? "";
  }
  return "";
}
