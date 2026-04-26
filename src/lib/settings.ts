import { getDb } from "./db.js";

export interface GlobalSettings {
  google_review_url: string;
  review_sms_message: string;
}

const DEFAULTS: GlobalSettings = {
  google_review_url: "",
  review_sms_message: "Hi! We'd love your feedback on our service. If you have a moment, please leave us a Google review:\n{{google_review_url}}\n\nThank you!\n— Service Call Saver",
};

function collection() {
  return getDb().collection<GlobalSettings & { _id: string }>("settings");
}

export async function getSettings(): Promise<GlobalSettings> {
  const doc = await collection().findOne({ _id: "global" } as any);
  if (!doc) return { ...DEFAULTS };
  return {
    google_review_url: doc.google_review_url ?? DEFAULTS.google_review_url,
    review_sms_message: doc.review_sms_message ?? DEFAULTS.review_sms_message,
  };
}

export async function updateSettings(
  updates: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  const setObj: Record<string, unknown> = {};
  if (updates.google_review_url !== undefined) setObj.google_review_url = updates.google_review_url;
  if (updates.review_sms_message !== undefined) setObj.review_sms_message = updates.review_sms_message;

  if (Object.keys(setObj).length === 0) {
    return getSettings();
  }

  await collection().updateOne(
    { _id: "global" } as any,
    { $set: setObj },
    { upsert: true },
  );

  return getSettings();
}
