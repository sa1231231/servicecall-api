import { getDb } from "./db.js";
import { setOwnerConfig } from "../config/notification-clients.js";

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
