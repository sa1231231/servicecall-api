import { getDb } from "./db.js";
import { setOwnerConfig } from "../config/notification-clients.js";
import type { FinetuneExample } from "./agent-generator/data-point-registry.js";

export interface CostRates {
  twilio_sms_cents: number;
  resend_email_cents: number;
  twilio_number_monthly_cents: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  twilio_sms_cents: 0.79,
  resend_email_cents: 0.04,
  twilio_number_monthly_cents: 115,
};

/** A single setup-instruction template (e.g. Verizon, AT&T, RingCentral).
 *  Keyed by `id` so the dashboard's send dropdown can identify the choice
 *  while letting the operator rename `label` without breaking outstanding
 *  references. `message` may use {{business_name}}, {{agent_phone}},
 *  {{agent_phone_10}}, and {{agent_phone_pretty}}. */
export interface SetupInstruction {
  id: string;
  label: string;
  message: string;
}

export interface GlobalSettings {
  google_review_url: string;
  review_sms_message: string;
  stripe_payment_url: string;
  payment_sms_message: string;
  portal_sms_message: string;
  free_trial_days: number;
  owner_email: string;
  owner_phone: string;
  default_summary_agent_id: string;
  setup_instructions?: SetupInstruction[];
  category_order?: string[];
  category_labels?: Record<string, string>;
  cost_rates?: CostRates;
  /** Pause toggle for the Apps Script lead sync. `undefined` is treated as
   *  enabled (fail-open) so the integration starts working as soon as the
   *  operator pastes the script — they have to deliberately turn it off. */
  lead_intake_enabled?: boolean;
  /** Workspace default fine-tune examples for the Admin/FAQ global node's
   *  positive_finetune_examples (when to jump to FAQ from anywhere). When
   *  unset, agent generation falls back to FAQ_GLOBAL_POSITIVE_EXAMPLES in
   *  node-builders.ts. Operators edit these in the Categories tab. */
  faq_global_finetune_examples?: FinetuneExample[];
  /** Workspace default fine-tune examples for the Close Question node's
   *  finetune_transition_examples (caller asks a follow-up question after
   *  "anything else?"). When unset, falls back to
   *  CLOSE_QUESTION_FAQ_FINETUNE_EXAMPLES. Destination is resolved to the
   *  Admin/FAQ node id at generation time. */
  close_question_finetune_examples?: FinetuneExample[];
  /** Workspace default positive examples for the Human Request global node
   *  (caller asks for a person / supervisor / human transfer). Merged on top
   *  of the built-in baseline at generation time. */
  human_request_finetune_examples?: FinetuneExample[];
  /** Workspace default fine-tune examples for the Intro node's
   *  finetune_transition_examples that target the Admin/FAQ global node
   *  (caller asks a question instead of stating a service request).
   *  When unset, falls back to INTRO_FAQ_FINETUNE_EXAMPLES in
   *  node-builders.ts. Destination resolves to the FAQ node id at
   *  generation time — no explicit edge from Intro to FAQ, same UI-clean
   *  pattern as Close Question. */
  intro_faq_finetune_examples?: FinetuneExample[];
  /** Workspace default positive FT examples for the Irrelevant Guardrail
   *  global node (caller goes off-topic / asks nonsense / tries to
   *  derail). Merged on top of IRRELEVANT_GUARDRAIL_POSITIVE_EXAMPLES
   *  at generation time — additive. */
  irrelevant_guardrail_finetune_examples?: FinetuneExample[];
}

function collection() {
  return getDb().collection<GlobalSettings & { _id: string }>("settings");
}

export async function getSettings(): Promise<GlobalSettings> {
  const doc = await collection().findOne({ _id: "global" } as any);
  return {
    google_review_url: doc?.google_review_url ?? "",
    review_sms_message: doc?.review_sms_message ?? "",
    stripe_payment_url: doc?.stripe_payment_url ?? "",
    payment_sms_message: doc?.payment_sms_message ?? "",
    portal_sms_message: doc?.portal_sms_message ?? "",
    free_trial_days: doc?.free_trial_days ?? 0,
    owner_email: doc?.owner_email ?? "",
    owner_phone: doc?.owner_phone ?? "",
    default_summary_agent_id: (doc as any)?.default_summary_agent_id ?? "",
    setup_instructions: Array.isArray((doc as any)?.setup_instructions)
      ? ((doc as any).setup_instructions as SetupInstruction[])
      : [],
    category_order: (doc as any)?.category_order ?? undefined,
    category_labels: (doc as any)?.category_labels ?? undefined,
    cost_rates: {
      twilio_sms_cents: (doc as any)?.cost_rates?.twilio_sms_cents ?? DEFAULT_COST_RATES.twilio_sms_cents,
      resend_email_cents: (doc as any)?.cost_rates?.resend_email_cents ?? DEFAULT_COST_RATES.resend_email_cents,
      twilio_number_monthly_cents: (doc as any)?.cost_rates?.twilio_number_monthly_cents ?? DEFAULT_COST_RATES.twilio_number_monthly_cents,
    },
    lead_intake_enabled: (doc as any)?.lead_intake_enabled,
    faq_global_finetune_examples: Array.isArray(
      (doc as any)?.faq_global_finetune_examples,
    )
      ? ((doc as any).faq_global_finetune_examples as FinetuneExample[])
      : undefined,
    close_question_finetune_examples: Array.isArray(
      (doc as any)?.close_question_finetune_examples,
    )
      ? ((doc as any).close_question_finetune_examples as FinetuneExample[])
      : undefined,
    human_request_finetune_examples: Array.isArray(
      (doc as any)?.human_request_finetune_examples,
    )
      ? ((doc as any).human_request_finetune_examples as FinetuneExample[])
      : undefined,
    intro_faq_finetune_examples: Array.isArray(
      (doc as any)?.intro_faq_finetune_examples,
    )
      ? ((doc as any).intro_faq_finetune_examples as FinetuneExample[])
      : undefined,
    irrelevant_guardrail_finetune_examples: Array.isArray(
      (doc as any)?.irrelevant_guardrail_finetune_examples,
    )
      ? ((doc as any).irrelevant_guardrail_finetune_examples as FinetuneExample[])
      : undefined,
  };
}

export async function updateSettings(
  updates: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  const setObj: Record<string, unknown> = {};
  if (updates.google_review_url !== undefined) setObj.google_review_url = updates.google_review_url;
  if (updates.review_sms_message !== undefined) setObj.review_sms_message = updates.review_sms_message;
  if (updates.stripe_payment_url !== undefined) setObj.stripe_payment_url = updates.stripe_payment_url;
  if (updates.payment_sms_message !== undefined) setObj.payment_sms_message = updates.payment_sms_message;
  if (updates.portal_sms_message !== undefined) setObj.portal_sms_message = updates.portal_sms_message;
  if (updates.free_trial_days !== undefined) setObj.free_trial_days = updates.free_trial_days;
  if (updates.owner_email !== undefined) setObj.owner_email = updates.owner_email;
  if (updates.owner_phone !== undefined) setObj.owner_phone = updates.owner_phone;
  if (updates.default_summary_agent_id !== undefined) setObj.default_summary_agent_id = updates.default_summary_agent_id;
  if (updates.setup_instructions !== undefined) setObj.setup_instructions = updates.setup_instructions;
  if (updates.category_order !== undefined) setObj.category_order = updates.category_order;
  if (updates.category_labels !== undefined) setObj.category_labels = updates.category_labels;
  if (updates.lead_intake_enabled !== undefined) setObj.lead_intake_enabled = updates.lead_intake_enabled;
  if (updates.faq_global_finetune_examples !== undefined) setObj.faq_global_finetune_examples = updates.faq_global_finetune_examples;
  if (updates.close_question_finetune_examples !== undefined) setObj.close_question_finetune_examples = updates.close_question_finetune_examples;
  if (updates.human_request_finetune_examples !== undefined) setObj.human_request_finetune_examples = updates.human_request_finetune_examples;
  if (updates.intro_faq_finetune_examples !== undefined) setObj.intro_faq_finetune_examples = updates.intro_faq_finetune_examples;
  if (updates.irrelevant_guardrail_finetune_examples !== undefined) setObj.irrelevant_guardrail_finetune_examples = updates.irrelevant_guardrail_finetune_examples;
  if (updates.cost_rates !== undefined) {
    // Merge into a complete CostRates object so nested writes don't drop sibling keys
    const current = await getSettings();
    setObj.cost_rates = {
      twilio_sms_cents: updates.cost_rates.twilio_sms_cents ?? current.cost_rates!.twilio_sms_cents,
      resend_email_cents: updates.cost_rates.resend_email_cents ?? current.cost_rates!.resend_email_cents,
      twilio_number_monthly_cents: updates.cost_rates.twilio_number_monthly_cents ?? current.cost_rates!.twilio_number_monthly_cents,
    };
  }

  if (Object.keys(setObj).length === 0) {
    return getSettings();
  }

  await collection().updateOne(
    { _id: "global" } as any,
    { $set: setObj },
    { upsert: true },
  );

  const settings = await getSettings();
  setOwnerConfig(settings.owner_email, settings.owner_phone);
  return settings;
}

/** Load owner config from MongoDB into the in-memory ownerConfig object. */
export async function refreshOwnerConfig(): Promise<void> {
  const settings = await getSettings();
  setOwnerConfig(settings.owner_email, settings.owner_phone);
  console.log(`[settings] owner config loaded: ${settings.owner_email}, ${settings.owner_phone}`);
}
