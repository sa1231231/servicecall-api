/**
 * ServiceCall Saver — Google Sheets → Pending Leads sync.
 *
 * Setup:
 *  1. Open the Sheet → Extensions → Apps Script. Paste this file in.
 *  2. Project Settings → Script properties. Add:
 *       API_BASE_URL       https://your-api-host          (no trailing slash)
 *       LEAD_INTAKE_TOKEN  <same value as the API env>
 *       SHEET_NAME         Leads                           (optional; first sheet if blank)
 *       NAME_COL           1                               (1-indexed column numbers)
 *       PHONE_COL          2
 *       WEBSITE_COL                                        (optional; leave blank to skip)
 *       NOTES_COL                                          (optional)
 *       STATUS_COL         5                               (we write the lead id / "paused" here)
 *       HEADER_ROWS        1                               (rows to skip at the top)
 *  3. Triggers → Add trigger → syncNewLeads → on change   (or time-based every 5 min).
 *
 * Behavior: rows whose STATUS_COL is empty get POSTed. On 201 we write the lead id
 * back so the row never re-syncs. On 423 (paused via dashboard toggle) we stop early
 * and leave the row unsynced — next run picks up from where we paused.
 */

const REQUIRED_PROPS = ['API_BASE_URL', 'LEAD_INTAKE_TOKEN', 'NAME_COL', 'STATUS_COL'];

function syncNewLeads() {
  const props = PropertiesService.getScriptProperties().getProperties();
  for (const k of REQUIRED_PROPS) {
    if (!props[k]) {
      Logger.log('Missing required Script Property: ' + k);
      return;
    }
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
    status: parseInt(props.STATUS_COL, 10),
  };

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const sheetRow = headerRows + 1 + i;
    const statusCell = String(row[cols.status - 1] || '').trim();
    if (statusCell) continue; // already synced

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

    const result = postLead(props.API_BASE_URL, props.LEAD_INTAKE_TOKEN, payload);
    if (result.code === 423) {
      Logger.log('Intake paused — stopping at row ' + sheetRow);
      return; // leave this and remaining rows unsynced
    }
    if (result.code === 201 && result.body && result.body._id) {
      sheet.getRange(sheetRow, cols.status).setValue(result.body._id);
    } else {
      // 4xx (bad payload) / 5xx (server error) — log and move on. Next run
      // retries since STATUS_COL is still empty.
      Logger.log('Row ' + sheetRow + ' sync failed: ' + result.code + ' ' + JSON.stringify(result.body));
    }
  }
}

function postLead(baseUrl, token, payload) {
  const url = baseUrl.replace(/\/$/, '') + '/api/leads/intake';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let body = null;
  try { body = JSON.parse(res.getContentText()); } catch (_) { body = res.getContentText(); }
  return { code: code, body: body };
}
