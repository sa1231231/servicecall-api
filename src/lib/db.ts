import { MongoClient, type Db } from "mongodb";
import { config } from "../config.js";

let db: Db;

export async function initDb(): Promise<Db> {
  const client = new MongoClient(config.MONGODB_URL);
  await client.connect();
  db = client.db();
  console.log("[db] connected to MongoDB");
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}
