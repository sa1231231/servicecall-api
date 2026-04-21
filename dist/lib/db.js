import { MongoClient } from "mongodb";
import { config } from "../config.js";
let db;
export async function initDb() {
    const client = new MongoClient(config.MONGODB_URL);
    await client.connect();
    db = client.db();
    console.log("[db] connected to MongoDB");
    return db;
}
export function getDb() {
    if (!db)
        throw new Error("Database not initialized — call initDb() first");
    return db;
}
