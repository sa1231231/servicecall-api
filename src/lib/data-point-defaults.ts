import { getDb } from "./db.js";
import {
  defaultExtractEquation,
  NOT_MENTIONED,
  CALLER_DOESNT_KNOW,
  type DataPoint,
} from "./agent-generator/data-point-registry.js";

// Display order for category sections
export const CATEGORY_ORDER: string[] = [
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

export const CATEGORY_LABELS: Record<string, string> = {
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

export interface StoredDataPoint extends DataPoint {
  category?: string;
  sortOrder?: number;
}

function collection() {
  return getDb().collection<StoredDataPoint & { _id: string }>(
    "data_point_defaults",
  );
}

/** Load all data point defaults as a lookup map. */
export async function getDataPointDefaults(): Promise<
  Record<string, DataPoint>
> {
  const docs = await collection().find({}).toArray();
  const map: Record<string, DataPoint> = {};
  for (const doc of docs) {
    const key = doc._id;
    const { _id, ...rest } = doc as any;
    map[key] = rest as DataPoint;
  }
  return map;
}

/** Load all data point defaults with category info for the form. */
export async function getDataPointDefaultsWithCategory(): Promise<
  Record<string, StoredDataPoint>
> {
  const docs = await collection().find({}).toArray();
  const map: Record<string, StoredDataPoint> = {};
  for (const doc of docs) {
    const key = doc._id;
    const { _id, ...rest } = doc as any;
    map[key] = rest as StoredDataPoint;
  }
  return map;
}

/** Get a single data point default. */
export async function getDataPointDefault(
  key: string,
): Promise<(StoredDataPoint & { _id: string }) | null> {
  return collection().findOne({ _id: key } as any) as any;
}

/** Update a single data point default. */
export async function updateDataPointDefault(
  key: string,
  updates: Partial<StoredDataPoint>,
): Promise<StoredDataPoint | null> {
  const result = await collection().findOneAndUpdate(
    { _id: key } as any,
    { $set: updates },
    { returnDocument: "after" },
  );
  if (result) {
    console.log(`[data-point-defaults] updated "${key}"`);
  }
  return result as any;
}

/** Create a new custom data point default. */
export async function createDataPointDefault(
  key: string,
  data: {
    label: string;
    category?: string;
    type?: "string" | "enum" | "boolean";
    choices?: string[];
    description?: string;
    conversationPrompt?: string;
    forwardCondition?: string;
  },
): Promise<StoredDataPoint> {
  const existing = await collection().findOne({ _id: key } as any);
  if (existing) {
    throw new Error(`Data point "${key}" already exists`);
  }

  // Determine sortOrder: put at the end of the target category
  const category = data.category || "custom";
  const allDocs = await collection().find({ category } as any).toArray();
  const maxOrder = allDocs.reduce((max, d) => Math.max(max, (d as any).sortOrder ?? 0), -1);

  const varName = key;
  const dp: StoredDataPoint & { _id: string } = {
    _id: key,
    label: data.label,
    variableName: varName,
    type: data.type || "string",
    choices: data.choices || [],
    description:
      data.description ||
      `${varName}. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt:
      data.conversationPrompt ||
      `Ask the caller for their ${varName.replace(/_/g, " ")}.\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition:
      data.forwardCondition ||
      `The caller has provided their ${varName.replace(/_/g, " ")} or has indicated they don't know it`,
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation(varName),
    category,
    sortOrder: maxOrder + 1,
  };

  await collection().insertOne(dp as any);
  console.log(`[data-point-defaults] created custom data point "${key}"`);
  const { _id, ...rest } = dp;
  return rest as StoredDataPoint;
}

/** Delete a data point default. */
export async function deleteDataPointDefault(key: string): Promise<boolean> {
  const result = await collection().deleteOne({ _id: key } as any);
  if (result.deletedCount > 0) {
    console.log(`[data-point-defaults] deleted data point "${key}"`);
    return true;
  }
  return false;
}

/** Bulk reorder data points — updates category and sortOrder for each item. */
export async function reorderDataPointDefaults(
  items: Array<{ key: string; category: string; sortOrder: number }>,
): Promise<void> {
  const bulk = collection().initializeUnorderedBulkOp();
  for (const item of items) {
    bulk.find({ _id: item.key } as any).updateOne({
      $set: { category: item.category, sortOrder: item.sortOrder },
    });
  }
  if (items.length > 0) {
    await bulk.execute();
    console.log(`[data-point-defaults] reordered ${items.length} data point(s)`);
  }
}
