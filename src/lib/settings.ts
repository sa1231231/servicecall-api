import { getDb } from "./db.js";
import { setOwnerConfig } from "../config/notification-clients.js";

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
 *  references. `message` may use {{business_name}} and {{agent_phone}}. */
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
