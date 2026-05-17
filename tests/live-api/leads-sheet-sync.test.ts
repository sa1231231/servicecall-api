import { describe, it, expect, afterAll } from "vitest";
import { JWT } from "google-auth-library";
import { hasSheetSyncEnv, getLiveEnv } from "./lib/env.js";
import { apiFetch, apiGet } from "./lib/api-client.js";

// End-to-end test for the Google Sheet → Pending Leads pipeline: append a row
// to the live sheet → wait for the DEPLOYED service to ingest it → verify the
// lead via the dashboard API → delete the row + dismiss the lead. This is the
// only test that exercises the real Sheets read against a live row; the poll
// job's pure mapping logic is unit-tested in
// src/lib/__tests__/leads-sheet-sync.test.ts.
//
// Dual-run note: during cutover the hardened Apps Script still watches this
// sheet, and its instant on-change trigger almost always ingests a new row
// before the 2-min poll job does. So the ingester is whichever won the race
// ("sheet" = poll job, "google_sheet" = Apps Script). Once the Apps Script is
// retired this deterministically exercises the poll job.
//
// Requires GOOGLE_SERVICE_ACCOUNT_JSON + LEADS_SHEET_SYNC in the env (the
// same two vars set on the deployed service). Skips silently without them.
//
// NOTE: this mutates the production sheet — it appends one row and deletes
// it again in afterAll. A crash mid-test may leave a "[SYSTEM TEST]" row;
// it's harmless (ingests as one dismissable junk lead) and clearly tagged.

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const INGEST_TIMEOUT_MS = 5 * 60_000; // poll runs every 2 min — allow margin
const POLL_INTERVAL_MS = 15_000;

interface SheetCfg {
  spreadsheetId: string;
  tab: string;
  cols: Record<string, number>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse GOOGLE_SERVICE_ACCOUNT_JSON — accepts raw JSON or base64 JSON. */
function parseServiceAccount(raw: string): { client_email: string; private_key: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  }
}

async function sheetsToken(serviceAccountJson: string): Promise<string> {
  const creds = parseServiceAccount(serviceAccountJson);
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [SHEETS_SCOPE],
  });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("failed to mint a Sheets access token");
  return token;
}

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

/** Resolve a tab name to its numeric sheetId (gid), needed for row deletion. */
async function getSheetId(token: string, spreadsheetId: string, tab: string): Promise<number> {
  const res = await fetch(
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`spreadsheets.get failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { sheets: Array<{ properties: { sheetId: number; title: string } }> };
  const match = body.sheets.find((s) => s.properties.title === tab);
  if (!match) throw new Error(`tab "${tab}" not found in spreadsheet`);
  return match.properties.sheetId;
}

/** Append a row; returns its 1-indexed row number (parsed from updatedRange). */
async function appendRow(
  token: string,
  spreadsheetId: string,
  tab: string,
  row: string[],
): Promise<number> {
  const res = await fetch(
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tab)}` +
      `:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    },
  );
  if (!res.ok) throw new Error(`values.append failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { updates?: { updatedRange?: string } };
  const updatedRange = body.updates?.updatedRange ?? "";
  const m = updatedRange.match(/![A-Z]+(\d+)/);
  if (!m) throw new Error(`could not parse appended row from updatedRange: ${updatedRange}`);
  return Number(m[1]);
}

/** Delete a single row by its 1-indexed number. */
async function deleteRow(
  token: string,
  spreadsheetId: string,
  sheetId: number,
  rowNumber: number,
): Promise<void> {
  const res = await fetch(`${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowNumber - 1, // 0-indexed
              endIndex: rowNumber,
            },
          },
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`batchUpdate deleteDimension failed: ${res.status} ${await res.text()}`);
}

describe.skipIf(!hasSheetSyncEnv)(
  "[live-api] leads sheet sync (sheet → poll → API)",
  { timeout: INGEST_TIMEOUT_MS + 60_000 },
  () => {
    // Cleanup state — populated as the test progresses.
    let token: string | undefined;
    let cfg: SheetCfg | undefined;
    let sheetId: number | undefined;
    let appendedRow: number | undefined;
    let createdLeadId: string | undefined;
    const testName = "[SYSTEM TEST] sheet-sync-" + Date.now();
    const externalId = "sys-test-l:" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);

    afterAll(async () => {
      // Delete the appended sheet row.
      if (token && cfg && sheetId != null && appendedRow != null) {
        await deleteRow(token, cfg.spreadsheetId, sheetId, appendedRow).catch(() => {});
      }
      // Dismiss the ingested lead. If the test failed before capturing the
      // id, do a last-ditch lookup by externalId so a late poll can't leave
      // a straggler.
      if (!createdLeadId) {
        try {
          const list = await apiGet<Array<{ _id: string; externalId?: string }>>(
            "/api/leads?include_terminal=1",
          );
          createdLeadId = list.find((l) => l.externalId === externalId)?._id;
        } catch { /* best-effort */ }
      }
      if (createdLeadId) {
        await apiFetch(`/api/leads/${createdLeadId}/dismiss`, {
          method: "POST",
          expectError: true,
        }).catch(() => {});
      }
    });

    it(
      "a new sheet row is ingested and reaches the API within one poll cycle",
      { timeout: INGEST_TIMEOUT_MS + 60_000 },
      async () => {
        const env = getLiveEnv();
        cfg = JSON.parse(env.leadsSheetSync!) as SheetCfg;
        const { cols } = cfg;

        token = await sheetsToken(env.googleServiceAccountJson!);
        sheetId = await getSheetId(token, cfg.spreadsheetId, cfg.tab);

        // Build the row with values at the configured 1-indexed columns.
        // Phone carries the Meta "p:" prefix so we verify it gets stripped.
        const width = Math.max(
          cols.name,
          cols.externalId,
          cols.phone ?? 0,
          cols.businessType ?? 0,
        );
        const row: string[] = new Array(width).fill("");
        row[cols.externalId - 1] = externalId;
        row[cols.name - 1] = testName;
        if (cols.phone) row[cols.phone - 1] = "p:+15555550123";
        if (cols.businessType) row[cols.businessType - 1] = "hvac";

        appendedRow = await appendRow(token, cfg.spreadsheetId, cfg.tab, row);

        // Wait for the deployed poll job to pick the row up.
        let lead:
          | { _id: string; source: string; externalId?: string; input: Record<string, any> }
          | undefined;
        const deadline = Date.now() + INGEST_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const list = await apiGet<Array<typeof lead & object>>(
            "/api/leads?include_terminal=1",
          );
          lead = list.find((l: any) => l.externalId === externalId);
          if (lead) break;
          await sleep(POLL_INTERVAL_MS);
        }

        expect(lead, "poll job did not ingest the appended row within timeout").toBeTruthy();
        createdLeadId = lead!._id;

        // Core assertion: the appended row reached the API as a lead.
        expect(lead!.externalId).toBe(externalId);
        expect(lead!.input.name).toBe(testName);

        // Whichever ingester won the race (see dual-run note above).
        expect(["sheet", "google_sheet"]).toContain(lead!.source);

        // Poll-job-specific mapping — the Apps Script does NOT strip the
        // Meta "p:" phone prefix, so only assert it when the poll job
        // ("sheet") was the ingester. After the Apps Script is retired this
        // branch always runs.
        if (lead!.source === "sheet") {
          if (cols.phone) expect(lead!.input.phone).toBe("+15555550123");
          if (cols.businessType) expect(lead!.input.business_type).toBe("hvac");
        }
      },
    );
  },
);
