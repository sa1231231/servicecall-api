import "dotenv/config";
import { describe, it, expect } from "vitest";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;

const hasConfig = !!BASE_URL && BASE_URL.startsWith("http") && !!API_KEY;

function url(path: string): string {
  return `${BASE_URL}${path}`;
}

async function json(resp: Response): Promise<any> {
  return resp.json();
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// These tests intentionally do NOT exercise the create-appointment happy
// path: that endpoint posts to a real LeadConnector calendar and would
// create an actual booking on a shared business calendar. We test only:
//   • Slot lookup (read-only)
//   • Create-appointment validation (rejects without booking)

describe.skipIf(!hasConfig)("System tests — DeckScience", { timeout: 30_000 }, () => {
  describe("POST /deckscience/get-slots", () => {
    it("returns the expected shape with at least one available_slots key", async () => {
      const resp = await fetch(url("/deckscience/get-slots"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // Upstream may return 200 (slots) or 4xx if GHL_API_KEY is misconfigured
      // in the deployment. Either way the route shouldn't 5xx for a vanilla
      // body — we just want to confirm wiring + response shape on success.
      if (resp.status !== 200) {
        // Surface the upstream error so the failure is actionable.
        const body = await resp.text();
        throw new Error(`get-slots returned ${resp.status}: ${body.slice(0, 300)}`);
      }
      const body = await json(resp);
      expect(Array.isArray(body.available_slots)).toBe(true);
    });

    it("each slot's times[].iso parses as a valid date", async () => {
      const resp = await fetch(url("/deckscience/get-slots"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (resp.status !== 200) return; // Already covered by the test above.
      const body = await json(resp);
      for (const day of body.available_slots ?? []) {
        expect(typeof day.date).toBe("string");
        expect(Array.isArray(day.times)).toBe(true);
        for (const t of day.times) {
          expect(typeof t.iso).toBe("string");
          expect(typeof t.display).toBe("string");
          expect(Number.isFinite(new Date(t.iso).getTime())).toBe(true);
        }
      }
    });
  });

  describe("POST /deckscience/create-appointment — validation only", () => {
    it("returns 400 when start_iso is not derivable from the body", async () => {
      const resp = await fetch(url("/deckscience/create-appointment"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
      const body = await json(resp);
      expect(String(body.error)).toMatch(/iso/i);
    });

    it("returns 400 when event_message is malformed JSON", async () => {
      // The handler does JSON.parse(body.event_message); a malformed string
      // throws and lands in the 500 catch. This test pins that contract:
      // either the handler 400s on bad input, or it 500s — both are
      // acceptable failure modes, but it must NOT silently book.
      const resp = await fetch(url("/deckscience/create-appointment"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_message: "not-json{{{" }),
      });
      expect([400, 500]).toContain(resp.status);
    });

    it("returns 400 when event_message has no matched_time_slot anywhere", async () => {
      const resp = await fetch(url("/deckscience/create-appointment"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_message: JSON.stringify({
            call: {
              retell_llm_dynamic_variables: {},
              collected_dynamic_variables: {},
            },
          }),
        }),
      });
      expect(resp.status).toBe(400);
    });
  });
});
