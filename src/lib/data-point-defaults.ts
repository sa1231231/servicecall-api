import { getDb } from "./db.js";
import {
  defaultExtractEquation,
  NOT_MENTIONED,
  CALLER_DOESNT_KNOW,
  type DataPoint,
  type VariableDef,
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
  // When composite is explicitly toggled off, wipe the nested variables and
  // restore a default extract equation on the parent so the dp goes back to
  // behaving as a single-variable extract.
  const $set: Partial<StoredDataPoint> = { ...updates };
  const $unset: Record<string, ""> = {};
  if (updates.composite === false) {
    delete ($set as any).composite;
    delete ($set as any).variables;
    $unset.composite = "";
    $unset.variables = "";
    if (!updates.extractSuccessEquation) {
      $set.extractSuccessEquation = defaultExtractEquation(key);
    }
  } else if (updates.composite === true && Array.isArray(updates.variables) && updates.variables.length > 0) {
    // Composite parents don't extract themselves.
    $set.extractSuccessEquation = [];
  }

  const update: Record<string, unknown> = { $set };
  if (Object.keys($unset).length > 0) update.$unset = $unset;

  const result = await collection().findOneAndUpdate(
    { _id: key } as any,
    update,
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
    composite?: boolean;
    variables?: VariableDef[];
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
  const isComposite = data.composite === true && Array.isArray(data.variables) && data.variables.length > 0;

  // For prompt/condition fields, distinguish between "not provided" (apply
  // the boilerplate default) and "explicitly empty" (operator wants the
  // field blank — e.g. for a hidden-value variable that the agent never
  // asks about). `||` treated empty strings as falsy and silently filled
  // them in; a typeof check preserves operator intent.
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
      typeof data.conversationPrompt === "string"
        ? data.conversationPrompt
        : `Ask the caller for their ${varName.replace(/_/g, " ")}.\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition:
      typeof data.forwardCondition === "string"
        ? data.forwardCondition
        : `The caller has provided their ${varName.replace(/_/g, " ")} or has indicated they don't know it`,
    finetuneExamples: [],
    // Composite parents don't extract themselves — their nested variables do.
    extractSuccessEquation: isComposite ? [] : defaultExtractEquation(varName),
    category,
    sortOrder: maxOrder + 1,
    ...(isComposite && { composite: true, variables: data.variables }),
  };

  await collection().insertOne(dp as any);
  console.log(`[data-point-defaults] created custom data point "${key}"${isComposite ? ` (composite: ${data.variables!.length} vars)` : ""}`);
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

/** Count data points in a given category. Used by the route's cascade-on-
 *  delete logic to decide whether to remove the category from settings. */
export async function countDataPointsInCategory(category: string): Promise<number> {
  return collection().countDocuments({ category } as any);
}

/** List every distinct `category` value present on a stored data point.
 *  Used by the orphan-cleanup pass to determine which categories in
 *  settings.category_order are actually backed by data and which have
 *  drifted into orphan state (every dp in them was deleted). */
export async function listUsedCategories(): Promise<string[]> {
  const docs = await collection().find({}, { projection: { category: 1 } } as any).toArray();
  const set = new Set<string>();
  for (const d of docs) {
    const cat = (d as any).category;
    if (typeof cat === "string" && cat.trim()) set.add(cat);
  }
  return [...set];
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
