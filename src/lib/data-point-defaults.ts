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
  // Caller Info
  full_name: "caller_info",
  phone_number: "caller_info",
  email: "caller_info",
  company_name: "caller_info",
  callback_number: "caller_info",
  existing_customer: "caller_info",
  caller_role: "caller_info",
  // Location
  street_address: "location",
  city: "location",
  state: "location",
  zip_code: "location",
  unit_number: "location",
  gate_code: "location",
  // Service Details
  service_type: "service_details",
  issue_description: "service_details",
  urgency_level: "service_details",
  special_instructions: "service_details",
  how_did_you_hear: "service_details",
  // Scheduling
  scheduling: "scheduling",
  // Property
  property_type: "property",
  number_of_stories: "property",
  year_built: "property",
  has_pets: "property",
  // Home Services
  equipment_brand: "home_services",
  equipment_age: "home_services",
  warranty_status: "home_services",
  // Legal Intake
  case_type: "legal_intake",
  opposing_party_name: "legal_intake",
  case_jurisdiction: "legal_intake",
  incident_date: "legal_intake",
  incident_location: "legal_intake",
  injury_description: "legal_intake",
  has_attorney: "legal_intake",
  medical_treatment: "legal_intake",
  // Trucking
  truck_number: "trucking",
  driver_name: "trucking",
  driver_phone: "trucking",
  breakdown_location: "trucking",
  problem_description: "trucking",
  vehicle_type: "trucking",
  vehicle_manufacturer: "trucking",
  vehicle_color: "trucking",
  // Billing
  whos_paying: "billing",
  payment_method: "billing",
  insurance_provider: "billing",
  policy_number: "billing",
  account_number: "billing",
};

// Default sort order within each category
const SORT_ORDER_MAP: Record<string, number> = {
  // Caller Info
  full_name: 0, phone_number: 1, email: 2, company_name: 3,
  callback_number: 4, existing_customer: 5, caller_role: 6,
  // Location
  street_address: 0, city: 1, state: 2, zip_code: 3,
  unit_number: 4, gate_code: 5,
  // Service Details
  service_type: 0, issue_description: 1, urgency_level: 2,
  special_instructions: 3, how_did_you_hear: 4,
  // Scheduling
  scheduling: 0,
  // Property
  property_type: 0, number_of_stories: 1, year_built: 2, has_pets: 3,
  // Home Services
  equipment_brand: 0, equipment_age: 1, warranty_status: 2,
  // Legal Intake
  case_type: 0, opposing_party_name: 1, case_jurisdiction: 2,
  incident_date: 3, incident_location: 4, injury_description: 5,
  has_attorney: 6, medical_treatment: 7,
  // Trucking
  truck_number: 0, driver_name: 1, driver_phone: 2,
  breakdown_location: 3, problem_description: 4, vehicle_type: 5,
  vehicle_manufacturer: 6, vehicle_color: 7,
  // Billing
  whos_paying: 0, payment_method: 1, insurance_provider: 2,
  policy_number: 3, account_number: 4,
};

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

/**
 * Seed any missing data points from the hard-coded registry.
 * Existing documents are NOT overwritten — MongoDB is canonical after first seed.
 * Also backfills the `category` and `sortOrder` fields on existing docs that lack them.
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
        category: CATEGORY_MAP[key] || "caller_info",
        sortOrder: SORT_ORDER_MAP[key] ?? 99,
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

  // Backfill category and sortOrder on existing docs that need it
  for (const doc of existing) {
    const updates: Record<string, any> = {};
    if (CATEGORY_MAP[doc._id] && doc.category !== CATEGORY_MAP[doc._id] && !doc.sortOrder) {
      // Only update category if sortOrder hasn't been set (user hasn't reordered)
      updates.category = CATEGORY_MAP[doc._id];
    }
    if (!doc.category && CATEGORY_MAP[doc._id]) {
      updates.category = CATEGORY_MAP[doc._id];
    }
    if (doc.sortOrder == null && SORT_ORDER_MAP[doc._id] != null) {
      updates.sortOrder = SORT_ORDER_MAP[doc._id];
    }
    if (Object.keys(updates).length > 0) {
      await collection().updateOne(
        { _id: doc._id } as any,
        { $set: updates },
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

/** Reset a data point to its hard-coded registry default. */
export async function resetDataPointDefault(
  key: string,
): Promise<DataPoint | null> {
  const registry = DATA_POINT_REGISTRY[key];
  if (!registry) return null;

  await collection().replaceOne(
    { _id: key } as any,
    {
      _id: key,
      ...registry,
      category: CATEGORY_MAP[key] || "caller_info",
      sortOrder: SORT_ORDER_MAP[key] ?? 99,
    } as any,
    { upsert: true },
  );
  console.log(`[data-point-defaults] reset "${key}" to registry default`);
  return { ...registry };
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
