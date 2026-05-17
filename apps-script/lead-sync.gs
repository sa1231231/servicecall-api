/**
 * ServiceCall Saver — Google Sheets → Pending Leads sync.
 *
 * The repo (apps-script/) is the source of truth. Deploy with clasp,
 * not copy/paste.
 *
 * One-time setup (per developer machine):
 *   npm i                         # picks up @google/clasp from devDeps
 *   npx clasp login               # OAuths your Google account once
 *   cd apps-script && npx clasp clone <scriptId>  # binds to the existing project
 *     (or: cd apps-script && npx clasp create --type sheets --title 'Lead Sync')
 *
 * Per-change deploy:
 *   npm run apps-script:push      # syncs apps-script/ → the bound project
 *
 * One-time Sheet/script configuration:
 *   1. Project Settings → Script properties:
 *        API_BASE_URL       https://your-api-host          (no trailing slash)
 *        LEAD_INTAKE_TOKEN  <same value as the API env>
 *        SHEET_NAME         Leads                           (optional; first sheet if blank)
 *        NAME_COL           1                               (1-indexed column numbers)
 *        PHONE_COL          2
 *        WEBSITE_COL                                        (optional; leave blank to skip)
 *        NOTES_COL                                          (optional)
 *        BUSINESS_TYPE_COL                                  (optional; column with a self-reported
 *                                                           industry/category from a form question
 *                                                           e.g. "which best fits the business you
 *                                                           have?". The API forwards it to the
 *                                                           enrichment skill as a disambiguation
 *                                                           hint for Places matching + templateName.)
 *        EXTERNAL_ID_COL                                    (optional; column with a stable upstream
 *                                                           id like Meta Lead Ads `l:...`. When set,
 *                                                           the API dedups by this id so the script
 *                                                           can re-POST every row on every run.)
 *        STATUS_COL                                         (optional; column where we write the lead
 *                                                           id back so the row never re-syncs. Faster
 *                                                           than EXTERNAL_ID_COL for large sheets.)
 *        HEADER_ROWS        1                               (rows to skip at the top)
 *
 *      You must set at least one of EXTERNAL_ID_COL or STATUS_COL — both is fine and gives
 *      you sheet-side fast-skip plus API-side safety net.
 *
 *   2. Run `installSyncTriggers` once from the Apps Script editor (function
 *      dropdown → Run). It installs both an `on change` trigger (near-instant
 *      sync) and a time-based trigger every 5 min (safety-net re-scan).
 *
 * Behavior: rows whose STATUS_COL is empty (or every non-header row, when STATUS_COL
 * isn't configured) get POSTed. On 201 (created) or 200 (already known via externalId
 * dedup) we treat the row as synced and write the lead id back to STATUS_COL when it's
 * configured. On 423 (paused via dashboard toggle) we stop early — next run picks up
 * from where we paused.
 *
 * Resilience: transient network failures ("Address unavailable", DNS, timeout) and
 * 5xx responses are retried with exponential backoff. If the API is still
 * unreachable after retries, the run stops cleanly (no thrown exception, no Apps
 * Script failure email) — the unsynced rows are picked up by the next trigger.
 */

const REQUIRED_PROPS = ['API_BASE_URL', 'LEAD_INTAKE_TOKEN', 'NAME_COL'];

function syncNewLeads() {
  // Serialize concurrent executions. With both an `on change` trigger and
  // a time-driven trigger enabled, two runs can overlap and POST the same
  // empty-STATUS_COL row twice before either has written the lead id back.
  // A short wait covers Zapier-style batched inserts that bunch up triggers.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('Another syncNewLeads run is in flight; skipping.');
    return;
  }
  try {
    syncNewLeadsImpl();
  } finally {
    lock.releaseLock();
  }
}

function syncNewLeadsImpl() {
  const props = PropertiesService.getScriptProperties().getProperties();
  for (const k of REQUIRED_PROPS) {
    if (!props[k]) {
      Logger.log('Missing required Script Property: ' + k);
      return;
    }
  }
  if (!props.STATUS_COL && !props.EXTERNAL_ID_COL) {
    Logger.log('Configure at least one of STATUS_COL or EXTERNAL_ID_COL — otherwise every run would re-create every row.');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = props.SHEET_NAME ? ss.getSheetByName(props.SHEET_NAME) : ss.getSheets()[0];
  if (!sheet) { Logger.log('Sheet not found: ' + props.SHEET_NAME); return; }

  const headerRows = parseInt(props.HEADER_ROWS || '1', 10);
  const lastRow = sheet.getLastRow();
  if (lastRow <= headerRows) return;

  const lastCol = sheet.getLastColumn();
  const values = sheet.getRange(headerRows + 1, 1, lastRow - headerRows, lastCol).getValues();

  const cols = {
    name: parseInt(props.NAME_COL, 10),
    phone: props.PHONE_COL ? parseInt(props.PHONE_COL, 10) : 0,
    website: props.WEBSITE_COL ? parseInt(props.WEBSITE_COL, 10) : 0,
    notes: props.NOTES_COL ? parseInt(props.NOTES_COL, 10) : 0,
    businessType: props.BUSINESS_TYPE_COL ? parseInt(props.BUSINESS_TYPE_COL, 10) : 0,
    status: props.STATUS_COL ? parseInt(props.STATUS_COL, 10) : 0,
    externalId: props.EXTERNAL_ID_COL ? parseInt(props.EXTERNAL_ID_COL, 10) : 0,
  };

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const sheetRow = headerRows + 1 + i;
    if (cols.status) {
      const statusCell = String(row[cols.status - 1] || '').trim();
      if (statusCell) continue; // already synced (sheet-side fast skip)
    }

    const name = String(row[cols.name - 1] || '').trim();
    if (!name) continue; // empty row — don't burn an API call

    const payload = { name: name, source: 'google_sheet' };
    if (cols.phone) {
      const phone = String(row[cols.phone - 1] || '').trim();
      if (phone) payload.phone = phone;
    }
    if (cols.website) {
      const website = String(row[cols.website - 1] || '').trim();
      if (website) payload.website = website;
    }
    if (cols.notes) {
      const notes = String(row[cols.notes - 1] || '').trim();
      if (notes) payload.notes = notes;
    }
    if (cols.businessType) {
      const businessType = String(row[cols.businessType - 1] || '').trim();
      if (businessType) payload.business_type = businessType;
    }
    if (cols.externalId) {
      const externalId = String(row[cols.externalId - 1] || '').trim();
      if (!externalId) continue; // no upstream id — can't dedup, skip rather than risk duplicates
      payload.externalId = externalId;
    }

    const result = postLead(props.API_BASE_URL, props.LEAD_INTAKE_TOKEN, payload);
    if (result.code === 423) {
      Logger.log('Intake paused — stopping at row ' + sheetRow);
      return; // leave this and remaining rows unsynced
    }
    if (result.code === 0) {
      // API unreachable after retries — stop rather than burn the 6-min
      // execution budget retrying every remaining row. STATUS_COL stays empty,
      // so the next run (on change / time-based) resyncs from here.
      Logger.log('API unreachable — stopping at row ' + sheetRow + '; will resync next run.');
      return;
    }
    // 200 = already known via externalId dedup; 201 = freshly created. Both
    // mean "synced, don't retry," so write the lead id back if STATUS_COL
    // is configured.
    if ((result.code === 201 || result.code === 200) && result.body && result.body._id) {
      if (cols.status) {
        sheet.getRange(sheetRow, cols.status).setValue(result.body._id);
      }
    } else {
      // 4xx (bad payload) / 5xx (server error) — log and move on. Next run
      // retries since STATUS_COL is still empty (or via externalId dedup
      // when STATUS_COL isn't configured).
      Logger.log('Row ' + sheetRow + ' sync failed: ' + result.code + ' ' + JSON.stringify(result.body));
    }
  }
}

const POST_MAX_ATTEMPTS = 4; // 1 try + 3 retries

// Exponential backoff with jitter: ~2s, 4s, 8s between attempts.
function backoffMs(attempt) {
  return Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
}

function postLead(baseUrl, token, payload) {
  const url = baseUrl.replace(/\/$/, '') + '/api/leads/intake';
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  let lastNetworkError = null;
  for (let attempt = 1; attempt <= POST_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = UrlFetchApp.fetch(url, options);
    } catch (e) {
      // Connection-level failure ("Address unavailable", DNS, timeout). This
      // throws even with muteHttpExceptions. Transient — retry with backoff.
      lastNetworkError = e;
      if (attempt < POST_MAX_ATTEMPTS) { Utilities.sleep(backoffMs(attempt)); continue; }
      break;
    }

    const code = res.getResponseCode();
    let body = null;
    try { body = JSON.parse(res.getContentText()); } catch (_) { body = res.getContentText(); }

    // 5xx: server reached but erroring (e.g. a mid-deploy restart). Retry.
    // 2xx/4xx: settled — return now (4xx is a client error; retrying won't fix it).
    if (code >= 500 && attempt < POST_MAX_ATTEMPTS) { Utilities.sleep(backoffMs(attempt)); continue; }
    return { code: code, body: body };
  }

  // Retries exhausted on a connection failure — the API is unreachable. Return
  // a sentinel instead of throwing so the run ends cleanly (no failure email).
  const msg = lastNetworkError && lastNetworkError.message ? lastNetworkError.message : 'unknown';
  Logger.log('postLead: API unreachable after ' + POST_MAX_ATTEMPTS + ' attempts: ' + msg);
  return { code: 0, body: 'unreachable: ' + msg };
}

/**
 * One-shot setup: install the triggers that drive syncNewLeads. Idempotent —
 * safe to re-run; existing syncNewLeads triggers are cleared first so it never
 * stacks duplicates.
 *
 * Run from the Apps Script editor: select `installSyncTriggers` in the function
 * dropdown → Run (approve the trigger-management permission prompt the first time).
 *
 * Installs two triggers:
 *   - on change   — near-instant sync when the sheet is edited.
 *   - every 5 min — safety-net re-scan, so a missed or failed on-change run (or a
 *                   transient API outage) self-heals: any row with an empty
 *                   STATUS_COL gets re-POSTed on the next tick.
 */
const SYNC_HANDLER = 'syncNewLeads';
const RESYNC_INTERVAL_MIN = 5;

function installSyncTriggers() {
  // Drop any existing syncNewLeads triggers so re-running stays idempotent.
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === SYNC_HANDLER) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.newTrigger(SYNC_HANDLER).forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger(SYNC_HANDLER).timeBased().everyMinutes(RESYNC_INTERVAL_MIN).create();

  const msg = 'Sync triggers installed: on change + every ' + RESYNC_INTERVAL_MIN +
    ' min' + (removed ? ' (replaced ' + removed + ' existing).' : '.');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (_) {}
}

/**
 * One-shot setup: append follow-up cadence checkboxes (cols 24–32) to the
 * lead tab, plus conditional formatting that flags overdue rows.
 *
 * Run from the Apps Script editor: select `setupFollowupColumns` in the
 * function dropdown → Run. Idempotent — safe to re-run; existing checkboxes
 * survive and matching conditional rules get replaced.
 *
 * Operates on the tab named in the SHEET_NAME script property (same one
 * syncNewLeads reads from), so renaming the tab only requires updating
 * that single property — no code change.
 */
const FOLLOWUP_FIRST_COL = 24;          // first column we append (after Notes at 23)
const FOLLOWUP_LAST_DATA_ROW = 1000;    // pre-populate this many rows with checkboxes
const FOLLOWUP_HEADERS = [
  '5-min response',  // 24 (col X) — within 5 min, two calls
  'D1 VM',           // 25 (col Y)
  'D1 Text 1',       // 26 (col Z)
  'D1 Attempt 2',    // 27 (col AA) — 2 more calls + Text 2
  'D1 Attempt 3',    // 28 (col AB) — 2 more calls + Text 3
  'D2 Done',         // 29 (col AC)
  'D3 Done',         // 30 (col AD)
  'D4 Done',         // 31 (col AE)
  'Outcome',         // 32 (col AF) — dropdown
];
const FOLLOWUP_OUTCOMES = ['Active', 'Connected', 'Booked', 'Lost', 'DNC'];

function setupFollowupColumns() {
  const sheetName = PropertiesService.getScriptProperties().getProperty('SHEET_NAME');
  if (!sheetName) {
    const msg = 'SHEET_NAME script property is not set. Configure it in Project Settings → Script Properties (same value syncNewLeads uses).';
    Logger.log(msg);
    try { SpreadsheetApp.getUi().alert(msg); } catch (_) {}
    return;
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    const msg = 'Tab "' + sheetName + '" not found. Check the SHEET_NAME value in Project Settings → Script Properties.';
    Logger.log(msg);
    try { SpreadsheetApp.getUi().alert(msg); } catch (_) {}
    return;
  }

  const checkboxCount = FOLLOWUP_HEADERS.length - 1;  // last col is dropdown, not a checkbox
  const lastCol = FOLLOWUP_FIRST_COL + FOLLOWUP_HEADERS.length - 1;
  const dataRows = FOLLOWUP_LAST_DATA_ROW - 1;

  // 1. Headers, bolded
  sheet.getRange(1, FOLLOWUP_FIRST_COL, 1, FOLLOWUP_HEADERS.length)
    .setValues([FOLLOWUP_HEADERS])
    .setFontWeight('bold');

  // 2. Checkboxes on cols 24-31, rows 2-1000
  sheet.getRange(2, FOLLOWUP_FIRST_COL, dataRows, checkboxCount).insertCheckboxes();

  // 3. Outcome dropdown on col 32, rows 2-1000
  const outcomeValidation = SpreadsheetApp.newDataValidation()
    .requireValueInList(FOLLOWUP_OUTCOMES, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, FOLLOWUP_FIRST_COL + checkboxCount, dataRows, 1)
    .setDataValidation(outcomeValidation);

  // 4. Conditional formatting on the entire row, rows 2-1000.
  //    Cols (1-indexed): id=1, created_time=2, full_name=15, ...,
  //    5-min=24 (X), VM=25 (Y), Text1=26 (Z), Att2=27 (AA), Att3=28 (AB).
  //
  //    Red = 5-min not done & a created_time exists (the SLA failed; needs
  //    immediate action). The formula references col X (24) by absolute col
  //    + relative row, so it follows down each row.
  //
  //    Yellow = lead is older than today AND any of the 4 D1 sub-steps
  //    (VM/Text1/Att2/Att3) is unchecked. The DATEVALUE(LEFT(...,10)) trick
  //    extracts the YYYY-MM-DD date portion of the ISO created_time string.
  const fullRowRange = sheet.getRange(2, 1, dataRows, lastCol);

  const redRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($B2<>"", NOT($X2))')
    .setBackground('#fce4e4')
    .setRanges([fullRowRange])
    .build();

  const yellowRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(
      '=AND($B2<>"", IFERROR(DATEVALUE(LEFT($B2,10)),0)<TODAY(), OR(NOT($Y2),NOT($Z2),NOT($AA2),NOT($AB2)))'
    )
    .setBackground('#fff4cc')
    .setRanges([fullRowRange])
    .build();

  // Idempotent rule replacement: drop any prior rules that look like ours
  // (formula references $X2 or $Y2) and append the fresh pair.
  const existing = sheet.getConditionalFormatRules();
  const kept = existing.filter(function (rule) {
    const cond = rule.getBooleanCondition && rule.getBooleanCondition();
    if (!cond) return true;
    const vals = cond.getCriteriaValues && cond.getCriteriaValues();
    if (!vals) return true;
    const formula = String(vals[0] || '');
    return formula.indexOf('$X2') === -1 && formula.indexOf('$Y2') === -1;
  });
  sheet.setConditionalFormatRules(kept.concat([redRule, yellowRule]));

  Logger.log('Follow-up columns ready. Cols ' + FOLLOWUP_FIRST_COL + '-' + lastCol +
    ' on tab "' + sheetName + '". Red = 5-min missed; yellow = Day 1 incomplete + day passed.');
  try {
    SpreadsheetApp.getUi().alert(
      'Follow-up columns ready on "' + sheetName + '" (cols ' +
      FOLLOWUP_FIRST_COL + '-' + lastCol + '). ' +
      'Red rows = 5-min SLA missed. Yellow = Day 1 incomplete after a day has passed.'
    );
  } catch (_) {}
}
