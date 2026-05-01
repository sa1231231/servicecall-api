import { getDb } from "./db.js";
import { defaultExtractEquation, NOT_MENTIONED, CALLER_DOESNT_KNOW, } from "./agent-generator/data-point-registry.js";
// Display order for category sections
export const CATEGORY_ORDER = [
    "caller_info",
    "location",
    "service_details",
    "scheduling",
    "property",
    "home_services",
    "legal_intake",
    "trucking",
    "billing",
];
export const CATEGORY_LABELS = {
    caller_info: "Caller Info",
    location: "Location",
    service_details: "Service Details",
    scheduling: "Scheduling",
    property: "Property",
    home_services: "Home Services",
    legal_intake: "Legal Intake",
    trucking: "Trucking",
    billing: "Billing",
};
function collection() {
    return getDb().collection("data_point_defaults");
}
/** Load all data point defaults as a lookup map. */
export async function getDataPointDefaults() {
    const docs = await collection().find({}).toArray();
    const map = {};
    for (const doc of docs) {
        const key = doc._id;
        const { _id, ...rest } = doc;
        map[key] = rest;
    }
    return map;
}
/** Load all data point defaults with category info for the form. */
export async function getDataPointDefaultsWithCategory() {
    const docs = await collection().find({}).toArray();
    const map = {};
    for (const doc of docs) {
        const key = doc._id;
        const { _id, ...rest } = doc;
        map[key] = rest;
    }
    return map;
}
/** Get a single data point default. */
export async function getDataPointDefault(key) {
    return collection().findOne({ _id: key });
}
/** Update a single data point default. */
export async function updateDataPointDefault(key, updates) {
    const result = await collection().findOneAndUpdate({ _id: key }, { $set: updates }, { returnDocument: "after" });
    if (result) {
        console.log(`[data-point-defaults] updated "${key}"`);
    }
    return result;
}
/** Create a new custom data point default. */
export async function createDataPointDefault(key, data) {
    const existing = await collection().findOne({ _id: key });
    if (existing) {
        throw new Error(`Data point "${key}" already exists`);
    }
    // Determine sortOrder: put at the end of the target category
    const category = data.category || "custom";
    const allDocs = await collection().find({ category }).toArray();
    const maxOrder = allDocs.reduce((max, d) => Math.max(max, d.sortOrder ?? 0), -1);
    const varName = key;
    const dp = {
        _id: key,
        label: data.label,
        variableName: varName,
        type: data.type || "string",
        choices: data.choices || [],
        description: data.description ||
            `${varName}. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
        conversationPrompt: data.conversationPrompt ||
            `Ask the caller for their ${varName.replace(/_/g, " ")}.\n\nIf the caller says they don't know, acknowledge it and move on.`,
        forwardCondition: data.forwardCondition ||
            `The caller has provided their ${varName.replace(/_/g, " ")} or has indicated they don't know it`,
        finetuneExamples: [],
        extractSuccessEquation: defaultExtractEquation(varName),
        category,
        sortOrder: maxOrder + 1,
    };
    await collection().insertOne(dp);
    console.log(`[data-point-defaults] created custom data point "${key}"`);
    const { _id, ...rest } = dp;
    return rest;
}
/** Delete a data point default. */
export async function deleteDataPointDefault(key) {
    const result = await collection().deleteOne({ _id: key });
    if (result.deletedCount > 0) {
        console.log(`[data-point-defaults] deleted data point "${key}"`);
        return true;
    }
    return false;
}
/** Bulk reorder data points — updates category and sortOrder for each item. */
export async function reorderDataPointDefaults(items) {
    const bulk = collection().initializeUnorderedBulkOp();
    for (const item of items) {
        bulk.find({ _id: item.key }).updateOne({
            $set: { category: item.category, sortOrder: item.sortOrder },
        });
    }
    if (items.length > 0) {
        await bulk.execute();
        console.log(`[data-point-defaults] reordered ${items.length} data point(s)`);
    }
}
