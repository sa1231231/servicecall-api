import { getDb } from "./db.js";
import {
  DATA_POINT_REGISTRY,
  type DataPoint,
} from "./agent-generator/data-point-registry.js";

function collection() {
  return getDb().collection<DataPoint & { _id: string }>("data_point_defaults");
}

/**
 * Seed any missing data points from the hard-coded registry.
 * Existing documents are NOT overwritten — MongoDB is canonical after first seed.
 */
export async function seedDataPointDefaults(): Promise<void> {
  const existing = await collection()
    .find({}, { projection: { _id: 1 } })
    .toArray();
  const existingKeys = new Set(existing.map((d) => d._id));

  const toInsert: Array<DataPoint & { _id: string }> = [];
  for (const [key, dp] of Object.entries(DATA_POINT_REGISTRY)) {
    if (!existingKeys.has(key)) {
      toInsert.push({ _id: key, ...dp });
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

/** Get a single data point default. */
export async function getDataPointDefault(
  key: string,
): Promise<(DataPoint & { _id: string }) | null> {
  return collection().findOne({ _id: key } as any) as any;
}

/** Update a single data point default. */
export async function updateDataPointDefault(
  key: string,
  updates: Partial<DataPoint>,
): Promise<DataPoint | null> {
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

/** Reset a data point to its hard-coded registry default. */
export async function resetDataPointDefault(
  key: string,
): Promise<DataPoint | null> {
  const registry = DATA_POINT_REGISTRY[key];
  if (!registry) return null;

  await collection().replaceOne(
    { _id: key } as any,
    { _id: key, ...registry } as any,
    { upsert: true },
  );
  console.log(`[data-point-defaults] reset "${key}" to registry default`);
  return { ...registry };
}
