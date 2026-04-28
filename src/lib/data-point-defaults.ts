import { getDb } from "./db.js";
import {
  DATA_POINT_REGISTRY,
  defaultExtractEquation,
  NOT_MENTIONED,
  CALLER_DOESNT_KNOW,
  type DataPoint,
} from "./agent-generator/data-point-registry.js";

// Category mapping for seeded registry data points
const CATEGORY_MAP: Record<string, string> = {
  full_name: "general",
  phone_number: "general",
  email: "general",
  street_address: "general",
  city: "general",
  company_name: "general",
  scheduling: "general",
  truck_number: "trucking",
  driver_name: "trucking",
  driver_phone: "trucking",
  breakdown_location: "trucking",
  problem_description: "trucking",
  vehicle_type: "trucking",
  vehicle_manufacturer: "trucking",
  vehicle_color: "trucking",
  whos_paying: "trucking",
  payment_method: "trucking",
};

export interface StoredDataPoint extends DataPoint {
  category?: string;
}

function collection() {
  return getDb().collection<StoredDataPoint & { _id: string }>(
    "data_point_defaults",
  );
}

/**
 * Seed any missing data points from the hard-coded registry.
 * Existing documents are NOT overwritten — MongoDB is canonical after first seed.
 * Also backfills the `category` field on existing docs that lack it.
 */
export async function seedDataPointDefaults(): Promise<void> {
  const existing = await collection().find({}).toArray();
  const existingKeys = new Set(existing.map((d) => d._id));

  // Insert missing
  const toInsert: Array<StoredDataPoint & { _id: string }> = [];
  for (const [key, dp] of Object.entries(DATA_POINT_REGISTRY)) {
    if (!existingKeys.has(key)) {
      toInsert.push({
        _id: key,
        ...dp,
        category: CATEGORY_MAP[key] || "general",
      });
    }
  }

  if (toInsert.length > 0) {
    await collection().insertMany(toInsert as any);
    console.log(
      `[data-point-defaults] seeded ${toInsert.length} data point(s): ${toInsert.map((d) => d._id).join(", ")}`,
    );
  } else {
    console.log("[data-point-defaults] all data points already seeded");
  }

  // Backfill category on existing docs that lack it
  for (const doc of existing) {
    if (!doc.category && CATEGORY_MAP[doc._id]) {
      await collection().updateOne(
        { _id: doc._id } as any,
        { $set: { category: CATEGORY_MAP[doc._id] } },
      );
    }
  }
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
    category: data.category || "custom",
  };

  await collection().insertOne(dp as any);
  console.log(`[data-point-defaults] created custom data point "${key}"`);
  const { _id, ...rest } = dp;
  return rest as StoredDataPoint;
}

/** Delete a custom data point (blocks deleting registry data points). */
export async function deleteDataPointDefault(key: string): Promise<boolean> {
  if (DATA_POINT_REGISTRY[key]) {
    throw new Error(
      `Cannot delete built-in data point "${key}". Use reset instead.`,
    );
  }
  const result = await collection().deleteOne({ _id: key } as any);
  if (result.deletedCount > 0) {
    console.log(`[data-point-defaults] deleted custom data point "${key}"`);
    return true;
  }
  return false;
}

/** Reset a data point to its hard-coded registry default. */
export async function resetDataPointDefault(
  key: string,
): Promise<DataPoint | null> {
  const registry = DATA_POINT_REGISTRY[key];
  if (!registry) return null;

  await collection().replaceOne(
    { _id: key } as any,
    { _id: key, ...registry, category: CATEGORY_MAP[key] || "general" } as any,
    { upsert: true },
  );
  console.log(`[data-point-defaults] reset "${key}" to registry default`);
  return { ...registry };
}
