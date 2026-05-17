import { describe, it, expect } from "vitest";
import {
  colToA1,
  parseSheetSyncConfig,
  buildLeadFromRow,
  type SheetSyncCols,
} from "../leads-sheet-sync.js";

describe("colToA1", () => {
  it.each([
    [1, "A"],
    [26, "Z"],
    [27, "AA"],
    [33, "AG"],
    [52, "AZ"],
    [53, "BA"],
    [702, "ZZ"],
    [703, "AAA"],
  ])("maps column %d → %s", (col, expected) => {
    expect(colToA1(col)).toBe(expected);
  });
});

describe("parseSheetSyncConfig", () => {
  const validCols = { name: 15, phone: 16, externalId: 1, status: 33 };
  const valid = JSON.stringify({ spreadsheetId: "sheet123", tab: "Leads", cols: validCols });

  it("returns null for empty / whitespace input", () => {
    expect(parseSheetSyncConfig("")).toBeNull();
    expect(parseSheetSyncConfig("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseSheetSyncConfig("{not json")).toBeNull();
  });

  it("returns null when spreadsheetId is missing", () => {
    expect(parseSheetSyncConfig(JSON.stringify({ cols: validCols }))).toBeNull();
  });

  it("returns null when cols.name is missing", () => {
    const raw = JSON.stringify({ spreadsheetId: "x", cols: { externalId: 1 } });
    expect(parseSheetSyncConfig(raw)).toBeNull();
  });

  it("returns null when neither externalId nor status is set", () => {
    const raw = JSON.stringify({ spreadsheetId: "x", cols: { name: 1 } });
    expect(parseSheetSyncConfig(raw)).toBeNull();
  });

  it("parses a valid config", () => {
    const cfg = parseSheetSyncConfig(valid);
    expect(cfg).toEqual({
      spreadsheetId: "sheet123",
      tab: "Leads",
      headerRows: 1,
      cols: {
        name: 15,
        phone: 16,
        website: 0,
        notes: 0,
        businessType: 0,
        externalId: 1,
        status: 33,
      },
    });
  });

  it("defaults tab to 'Leads' and headerRows to 1", () => {
    const raw = JSON.stringify({ spreadsheetId: "x", cols: { name: 1, status: 2 } });
    const cfg = parseSheetSyncConfig(raw)!;
    expect(cfg.tab).toBe("Leads");
    expect(cfg.headerRows).toBe(1);
  });

  it("honors explicit tab and headerRows", () => {
    const raw = JSON.stringify({
      spreadsheetId: "x",
      tab: "Sheet2",
      headerRows: 3,
      cols: { name: 1, status: 2 },
    });
    const cfg = parseSheetSyncConfig(raw)!;
    expect(cfg.tab).toBe("Sheet2");
    expect(cfg.headerRows).toBe(3);
  });

  it("coerces zero / negative / non-numeric column values to 0", () => {
    const raw = JSON.stringify({
      spreadsheetId: "x",
      cols: { name: 1, status: 2, phone: -4, website: "nope", notes: 0 },
    });
    const cfg = parseSheetSyncConfig(raw)!;
    expect(cfg.cols.phone).toBe(0);
    expect(cfg.cols.website).toBe(0);
    expect(cfg.cols.notes).toBe(0);
  });
});

describe("buildLeadFromRow", () => {
  // 1-indexed columns: name=1, phone=2, website=3, notes=4,
  // businessType=5, externalId=6, status=7.
  const cols: SheetSyncCols = {
    name: 1,
    phone: 2,
    website: 3,
    notes: 4,
    businessType: 5,
    externalId: 6,
    status: 7,
  };

  it("skips a row whose status cell is already filled", () => {
    const row = ["Acme HVAC", "555-1234", "", "", "", "l:abc", "lead_id_xyz"];
    expect(buildLeadFromRow(row, cols)).toBeNull();
  });

  it("skips a row with no name", () => {
    const row = ["", "555-1234", "", "", "", "l:abc", ""];
    expect(buildLeadFromRow(row, cols)).toBeNull();
  });

  it("skips a row when externalId is configured but blank", () => {
    const row = ["Acme HVAC", "555-1234", "", "", "", "", ""];
    expect(buildLeadFromRow(row, cols)).toBeNull();
  });

  it("maps a full row to input + externalId", () => {
    const row = [
      "Acme HVAC",
      "555-1234",
      "acme.com",
      "called twice",
      "Heating & Cooling",
      "l:abc",
      "",
    ];
    expect(buildLeadFromRow(row, cols)).toEqual({
      input: {
        name: "Acme HVAC",
        phone: "555-1234",
        website: "acme.com",
        notes: "called twice",
        business_type: "Heating & Cooling",
      },
      externalId: "l:abc",
    });
  });

  it("omits optional fields that are blank, and trims values", () => {
    const row = ["  Bob Plumbing  ", "", "  ", "", "", "l:def", ""];
    expect(buildLeadFromRow(row, cols)).toEqual({
      input: { name: "Bob Plumbing" },
      externalId: "l:def",
    });
  });

  it("strips the Meta 'p:' prefix from the phone number", () => {
    const row = ["Ramon", "p:+12062713262", "", "", "", "l:833856", ""];
    expect(buildLeadFromRow(row, cols)).toEqual({
      input: { name: "Ramon", phone: "+12062713262" },
      externalId: "l:833856",
    });
  });

  it("builds without externalId when that column is not configured", () => {
    const noExtCols: SheetSyncCols = { ...cols, externalId: 0 };
    const row = ["Acme HVAC", "555-1234", "", "", "", "", ""];
    expect(buildLeadFromRow(row, noExtCols)).toEqual({
      input: { name: "Acme HVAC", phone: "555-1234" },
    });
  });
});
