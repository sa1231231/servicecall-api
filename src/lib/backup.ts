import { gzipSync } from "zlib";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { getDb } from "./db.js";

const BACKUP_PREFIX = "backups/";
const RETENTION_DAYS = 30;
const COLLECTIONS = ["clients", "call_logs", "settings", "data_point_defaults"];

function getR2Client(): S3Client | null {
  if (!config.R2_ENDPOINT || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  return new S3Client({
    region: "auto",
    endpoint: config.R2_ENDPOINT,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });
}

export async function runBackup(): Promise<{ success: boolean; key?: string; error?: string }> {
  const r2 = getR2Client();
  if (!r2) {
    console.log("[backup] skipped — R2 env vars not configured");
    return { success: false, error: "R2 not configured" };
  }

  const start = Date.now();
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const hour = now.getUTCHours().toString().padStart(2, "0");
  const key = `${BACKUP_PREFIX}${date}_${hour}00.json.gz`;

  try {
    // Export all collections
    const db = getDb();
    const dump: Record<string, unknown[]> = {};

    for (const name of COLLECTIONS) {
      const docs = await db.collection(name).find().toArray();
      dump[name] = docs;
      console.log(`[backup] exported ${docs.length} docs from ${name}`);
    }

    // Gzip
    const json = JSON.stringify(dump);
    const gzipped = gzipSync(Buffer.from(json, "utf-8"));
    const sizeMb = (gzipped.length / 1024 / 1024).toFixed(2);

    // Upload to R2
    await r2.send(new PutObjectCommand({
      Bucket: config.R2_BUCKET,
      Key: key,
      Body: gzipped,
      ContentType: "application/gzip",
    }));

    const durationMs = Date.now() - start;
    console.log(`[backup] uploaded ${key} (${sizeMb} MB) in ${durationMs}ms`);

    // Clean up old backups
    await cleanupOldBackups(r2);

    return { success: true, key };
  } catch (err: any) {
    console.error(`[backup] failed:`, err.message);
    return { success: false, error: err.message };
  }
}

async function cleanupOldBackups(r2: S3Client): Promise<void> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

    const list = await r2.send(new ListObjectsV2Command({
      Bucket: config.R2_BUCKET,
      Prefix: BACKUP_PREFIX,
    }));

    const toDelete = (list.Contents ?? [])
      .filter((obj) => obj.LastModified && obj.LastModified < cutoff)
      .map((obj) => ({ Key: obj.Key! }));

    if (toDelete.length === 0) return;

    await r2.send(new DeleteObjectsCommand({
      Bucket: config.R2_BUCKET,
      Delete: { Objects: toDelete },
    }));

    console.log(`[backup] cleaned up ${toDelete.length} backup(s) older than ${RETENTION_DAYS} days`);
  } catch (err: any) {
    console.error(`[backup] cleanup failed:`, err.message);
  }
}

export function isR2Configured(): boolean {
  return !!(config.R2_ENDPOINT && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY);
}
