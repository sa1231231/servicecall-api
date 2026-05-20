import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";

const REPO_BACKUP_PREFIX = "repo-backups/";
const REPO_RETENTION_DAYS = 90;
const GITHUB_OWNER = "sa1231231";
const GITHUB_REPO = "servicecall-api";

const execFileP = promisify(execFile);

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

export function isGitBundleBackupConfigured(): boolean {
  return !!(
    config.R2_ENDPOINT &&
    config.R2_ACCESS_KEY_ID &&
    config.R2_SECRET_ACCESS_KEY &&
    config.GITHUB_TOKEN
  );
}

export async function runGitBundleBackup(): Promise<{ success: boolean; key?: string; error?: string }> {
  if (!isGitBundleBackupConfigured()) {
    console.log("[repo-backup] skipped — env vars not configured (need R2_* and GITHUB_TOKEN)");
    return { success: false, error: "not configured" };
  }
  const r2 = getR2Client()!;

  const start = Date.now();
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `${REPO_BACKUP_PREFIX}${date}.bundle`;

  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), "repo-backup-"));
    const repoDir = join(workDir, "repo.git");
    const bundlePath = join(workDir, "repo.bundle");

    // The token is embedded in the URL only for this single clone; it never
    // touches argv logs because execFile doesn't go through a shell, and we
    // don't log the URL ourselves.
    const cloneUrl = `https://x-access-token:${config.GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
    await execFileP("git", ["clone", "--mirror", cloneUrl, repoDir], { maxBuffer: 64 * 1024 * 1024 });
    await execFileP("git", ["-C", repoDir, "bundle", "create", bundlePath, "--all"], { maxBuffer: 64 * 1024 * 1024 });

    const bundle = await readFile(bundlePath);
    const sizeMb = (bundle.length / 1024 / 1024).toFixed(2);

    await r2.send(new PutObjectCommand({
      Bucket: config.R2_BUCKET,
      Key: key,
      Body: bundle,
      ContentType: "application/octet-stream",
    }));

    const durationMs = Date.now() - start;
    console.log(`[repo-backup] uploaded ${key} (${sizeMb} MB) in ${durationMs}ms`);

    await cleanupOldRepoBackups(r2);

    return { success: true, key };
  } catch (err: any) {
    // Strip the token out of any error message before logging.
    const safeMsg = String(err?.message ?? err).replace(
      /x-access-token:[^@]+@/g,
      "x-access-token:***@",
    );
    console.error(`[repo-backup] failed:`, safeMsg);
    return { success: false, error: safeMsg };
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function cleanupOldRepoBackups(r2: S3Client): Promise<void> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - REPO_RETENTION_DAYS);

    const list = await r2.send(new ListObjectsV2Command({
      Bucket: config.R2_BUCKET,
      Prefix: REPO_BACKUP_PREFIX,
    }));

    const toDelete = (list.Contents ?? [])
      .filter((obj) => obj.LastModified && obj.LastModified < cutoff)
      .map((obj) => ({ Key: obj.Key! }));

    if (toDelete.length === 0) return;

    await r2.send(new DeleteObjectsCommand({
      Bucket: config.R2_BUCKET,
      Delete: { Objects: toDelete },
    }));

    console.log(`[repo-backup] cleaned up ${toDelete.length} bundle(s) older than ${REPO_RETENTION_DAYS} days`);
  } catch (err: any) {
    console.error(`[repo-backup] cleanup failed:`, err.message);
  }
}

async function todayBundleExists(r2: S3Client): Promise<boolean> {
  const date = new Date().toISOString().slice(0, 10);
  const key = `${REPO_BACKUP_PREFIX}${date}.bundle`;
  try {
    await r2.send(new HeadObjectCommand({ Bucket: config.R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export function startGitBundleBackup(): void {
  if (!isGitBundleBackupConfigured()) {
    console.log("[repo-backup] skipped — env vars not configured");
    return;
  }

  // Catch-up on boot: if today's bundle is missing (first deploy after the
  // feature lands, or a multi-day outage straddling 03:00 UTC), fire now.
  // Same-day re-boots no-op because today's key already exists.
  (async () => {
    const r2 = getR2Client();
    if (r2 && !(await todayBundleExists(r2))) {
      console.log("[repo-backup] today's bundle missing — running catch-up now");
      await runGitBundleBackup();
    }
  })().catch(() => {});

  // Daily, aligned to 03:00 UTC (off-peak; well clear of the hourly DB backup
  // and the weekly report scheduler).
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(3, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  const msUntilFirst = next.getTime() - now.getTime();

  console.log(`[repo-backup] scheduled daily at 03:00 UTC (first in ${Math.round(msUntilFirst / 60000)} min)`);
  setTimeout(() => {
    runGitBundleBackup().catch(() => {});
    setInterval(() => runGitBundleBackup().catch(() => {}), DAY_MS);
  }, msUntilFirst);
}
