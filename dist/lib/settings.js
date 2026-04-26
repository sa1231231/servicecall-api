import { getDb } from "./db.js";
import { setOwnerConfig } from "../config/notification-clients.js";
const DEFAULTS = {
    google_review_url: "",
    review_sms_message: "Hi! We'd love your feedback on our service. If you have a moment, please leave us a Google review:\n{{google_review_url}}\n\nThank you!\n— Service Call Saver",
    owner_email: "samasra93@gmail.com",
    owner_phone: "+13017872841",
};
function collection() {
    return getDb().collection("settings");
}
export async function getSettings() {
    const doc = await collection().findOne({ _id: "global" });
    if (!doc)
        return { ...DEFAULTS };
    return {
        google_review_url: doc.google_review_url ?? DEFAULTS.google_review_url,
        review_sms_message: doc.review_sms_message ?? DEFAULTS.review_sms_message,
        owner_email: doc.owner_email ?? DEFAULTS.owner_email,
        owner_phone: doc.owner_phone ?? DEFAULTS.owner_phone,
    };
}
export async function updateSettings(updates) {
    const setObj = {};
    if (updates.google_review_url !== undefined)
        setObj.google_review_url = updates.google_review_url;
    if (updates.review_sms_message !== undefined)
        setObj.review_sms_message = updates.review_sms_message;
    if (updates.owner_email !== undefined)
        setObj.owner_email = updates.owner_email;
    if (updates.owner_phone !== undefined)
        setObj.owner_phone = updates.owner_phone;
    if (Object.keys(setObj).length === 0) {
        return getSettings();
    }
    await collection().updateOne({ _id: "global" }, { $set: setObj }, { upsert: true });
    const settings = await getSettings();
    setOwnerConfig(settings.owner_email, settings.owner_phone);
    return settings;
}
/** Load owner config from MongoDB into the in-memory ownerConfig object. */
export async function refreshOwnerConfig() {
    const settings = await getSettings();
    setOwnerConfig(settings.owner_email, settings.owner_phone);
    console.log(`[settings] owner config loaded: ${settings.owner_email}, ${settings.owner_phone}`);
}
