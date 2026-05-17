import { JWT } from "google-auth-library";
import { config } from "../config.js";
import { getSettings } from "./settings.js";
import { ingestLead } from "./lead-intake.js";
import type { PendingLeadInput } from "./pending-leads.js";

/**
 * Google Sheet → Pending Leads poll job.
 *
 * Replaces the container-bound Apps Script (`apps-script/lead-sync.gs`): instead
 * of Google's infra POSTing rows to us, the API pulls rows from the sheet via
 * the Sheets v4 REST API on a timer and ingests them in-process. Same logs,
 * retries, and deploy pipeline as the rest of the service.
 *
 * Configured by two env vars (see config.ts) — the job self-disables when
 * either is unset:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  service-account key (raw JSON or base64)
 *   LEADS_SHEET_SYNC             JSON: { spreadsheetId, tab?, headerRows?, cols }
 *
 * `cols` maps fields to 1-indexed column numbers; 0/absent means "not present":
 *   { name, phone?, website?, notes?, businessType?, externalId?, status? }
 * At least one of `externalId` or `status` must be set — otherwise every poll
 * would re-create every row.
 */

const POLL_INTERVAL_MS = 2 * 60_000;
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export interface SheetSyncCols {
  name: number;
  phone: number;
  website: number;
  notes: number;
  businessType: number;
  externalId: number;
  status: number;
}

export interface SheetSyncConfig {
  spreadsheetId: string;
  tab: string;
  headerRows: number;
  cols: SheetSyncCols;
}

/** Convert a 1-indexed column number to its A1 letter(s): 1→A, 26→Z, 27→AA. */
export function colToA1(col: number): string {
  let n = col;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Parse the LEADS_SHEET_SYNC env var into a validated config, or return null
 * (sync disabled) when it's empty or malformed.
 */
export function parseSheetSyncConfig(raw: string = config.LEADS_SHEET_SYNC): SheetSyncConfig | null {
  if (!raw || !raw.trim()) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[leads-sheet-sync] LEADS_SHEET_SYNC is not valid JSON — sync disabled");
    return null;
  }
  const spreadsheetId = typeof parsed.spreadsheetId === "string" ? parsed.spreadsheetId.trim() : "";
  if (!spreadsheetId) {
    console.error("[leads-sheet-sync] LEADS_SHEET_SYNC.spreadsheetId missing — sync disabled");
    return null;
  }
  const rawCols = parsed.cols && typeof parsed.cols === "object" ? parsed.cols : {};
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? Math.floor(v) : 0);
  const cols: SheetSyncCols = {
    name: num(rawCols.name),
    phone: num(rawCols.phone),
    website: num(rawCols.website),
    notes: num(rawCols.notes),
    businessType: num(rawCols.businessType),
    externalId: num(rawCols.externalId),
    status: num(rawCols.status),
  };
  if (!cols.name) {
    console.error("[leads-sheet-sync] LEADS_SHEET_SYNC.cols.name missing — sync disabled");
    return null;
  }
  if (!cols.externalId && !cols.status) {
    console.error(
      "[leads-sheet-sync] LEADS_SHEET_SYNC needs cols.externalId or cols.status — " +
        "without either, every poll would re-create every row. Sync disabled.",
    );
    return null;
  }
  return {
    spreadsheetId,
    tab: typeof parsed.tab === "string" && parsed.tab.trim() ? parsed.tab.trim() : "Leads",
    headerRows:
      typeof parsed.headerRows === "number" && parsed.headerRows >= 0
        ? Math.floor(parsed.headerRows)
        : 1,
    cols,
  };
}

/** Read a 1-indexed cell from a row as a trimmed string ("" when col is 0/empty). */
function cellAt(row: unknown[], col: number): string {
  if (!col) return "";
  return String(row[col - 1] ?? "").trim();
}

/**
 * Map one sheet row to a lead payload, or null when the row should be skipped:
 * already synced (status cell filled), no name, or externalId configured but
 * blank (can't dedup → skip rather than risk a duplicate).
 */
export function buildLeadFromRow(
  row: unknown[],
  cols: SheetSyncCols,
): { input: PendingLeadInput; externalId?: string } | null {
  if (cols.status && cellAt(row, cols.status)) return null; // already synced
  const name = cellAt(row, cols.name);
  if (!name) return null;
  const externalId = cellAt(row, cols.externalId);
  if (cols.externalId && !externalId) return null;

  const input: PendingLeadInput = { name };
  // Meta Lead Ads exports the phone with a "p:" column-value prefix
  // (e.g. "p:+12062713262") — strip it so downstream gets a clean number.
  const phone = cellAt(row, cols.phone).replace(/^p:/, "");
  if (phone) input.phone = phone;
  const website = cellAt(row, cols.website);
  if (website) input.website = website;
  const notes = cellAt(row, cols.notes);
  if (notes) input.notes = notes;
  const businessType = cellAt(row, cols.businessType);
  if (businessType) input.business_type = businessType;

  return externalId ? { input, externalId } : { input };
}

// ── Google auth ──────────────────────────────────────────────────────────────

let jwtClient: JWT | null = null;

/** Build (once) a service-account JWT client from GOOGLE_SERVICE_ACCOUNT_JSON,
 *  which may be raw JSON or base64-encoded JSON. */
function getJwtClient(): JWT | null {
  if (jwtClient) return jwtClient;
  const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) return null;
  let creds: any;
  try {
    creds = JSON.parse(raw);
  } catch {
    try {
      creds = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      console.error("[leads-sheet-sync] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON");
      return null;
    }
  }
  if (!creds.client_email || !creds.private_key) {
    console.error("[leads-sheet-sync] service-account JSON missing client_email/private_key");
    return null;
  }
  jwtClient = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [SHEETS_SCOPE],
  });
  return jwtClient;
}

async function getAccessToken(): Promise<string | null> {
  const client = getJwtClient();
  if (!client) return null;
  const { token } = await client.getAccessToken();
  return token ?? null;
}

// ── Sheets REST calls ────────────────────────────────────────────────────────

async function readSheetRows(token: string, cfg: SheetSyncConfig): Promise<unknown[][]> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.spreadsheetId)}` +
    `/values/${encodeURIComponent(cfg.tab)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Sheets read failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { values?: unknown[][] };
  return body.values ?? [];
}

/** Write lead ids back into the status column with a single batchUpdate. */
async function writeStatusBack(
  token: string,
  cfg: SheetSyncConfig,
  updates: Array<{ rowNumber: number; leadId: string }>,
): Promise<void> {
  if (updates.length === 0) return;
  const statusA1 = colToA1(cfg.cols.status);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.spreadsheetId)}` +
    `/values:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: updates.map((u) => ({
        range: `${cfg.tab}!${statusA1}${u.rowNumber}`,
        values: [[u.leadId]],
      })),
    }),
  });
  if (!res.ok) {
    // Non-fatal: externalId dedup keeps the next poll idempotent even if the
    // status cells never get written.
    console.error(`[leads-sheet-sync] status write-back failed: ${res.status} ${await res.text()}`);
  }
}

// ── Poll job ─────────────────────────────────────────────────────────────────

let running = false;

/** One poll pass: read the sheet, ingest unsynced rows, write lead ids back. */
export async function runLeadsSheetSync(): Promise<void> {
  const cfg = parseSheetSyncConfig();
  if (!cfg) return;

  if (running) {
    console.log("[leads-sheet-sync] previous run still in flight; skipping.");
    return;
  }
  running = true;
  try {
    // Respect the operator pause toggle, same as POST /api/leads/intake.
    const settings = await getSettings();
    if (settings.lead_intake_enabled === false) {
      console.log("[leads-sheet-sync] lead intake paused — skipping run.");
      return;
    }

    const token = await getAccessToken();
    if (!token) {
      console.error("[leads-sheet-sync] no access token (check GOOGLE_SERVICE_ACCOUNT_JSON)");
      return;
    }

    const rows = await readSheetRows(token, cfg);
    const dataRows = rows.slice(cfg.headerRows);

    let created = 0;
    let deduped = 0;
    let skipped = 0;
    let errors = 0;
    const writeBack: Array<{ rowNumber: number; leadId: string }> = [];

    for (let i = 0; i < dataRows.length; i++) {
      const rowNumber = cfg.headerRows + 1 + i;
      const built = buildLeadFromRow(dataRows[i] ?? [], cfg.cols);
      if (!built) {
        skipped++;
        continue;
      }
      try {
        const result = await ingestLead({
          source: "sheet",
          input: built.input,
          externalId: built.externalId,
        });
        if (result.deduped) deduped++;
        else created++;
        // Stamp the lead id into the status column so the row fast-skips on
        // the next poll. Done for deduped rows too — covers a row first
        // ingested by the Apps Script whose status cell was never written.
        if (cfg.cols.status) {
          writeBack.push({ rowNumber, leadId: result.lead._id });
        }
      } catch (err) {
        errors++;
        console.error(
          `[leads-sheet-sync] row ${rowNumber} ingest failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (cfg.cols.status) {
      await writeStatusBack(token, cfg, writeBack);
    }

    console.log(
      `[leads-sheet-sync] complete: ${created} created, ${deduped} deduped, ` +
        `${skipped} skipped, ${errors} errors`,
    );
  } catch (err) {
    console.error(
      "[leads-sheet-sync] run failed:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    running = false;
  }
}

/** Start the poll timer. No-op (with a log) when the sync isn't configured. */
export function startLeadsSheetSync(): void {
  const cfg = parseSheetSyncConfig();
  if (!cfg) {
    console.log("[leads-sheet-sync] not configured (LEADS_SHEET_SYNC unset) — skipping.");
    return;
  }
  if (!getJwtClient()) {
    console.log("[leads-sheet-sync] not configured (GOOGLE_SERVICE_ACCOUNT_JSON unset) — skipping.");
    return;
  }
  console.log(
    `[leads-sheet-sync] scheduled Google Sheet -> Pending Leads poll every ` +
      `${POLL_INTERVAL_MS / 60_000} minutes (sheet ${cfg.spreadsheetId}, tab "${cfg.tab}")`,
  );
  setInterval(() => {
    runLeadsSheetSync().catch(() => {});
  }, POLL_INTERVAL_MS);
}
