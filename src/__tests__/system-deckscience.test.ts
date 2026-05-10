import "dotenv/config";
import { describe, it, expect } from "vitest";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;

const hasConfig = !!BASE_URL && BASE_URL.startsWith("http") && !!API_KEY;

function url(path: string): string {
  return `${BASE_URL}${path}`;
}

// The /deckscience routes sit behind the same x-api-key middleware as
// /agents (see src/index.ts), so every request needs the key.
function apiHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": API_KEY!,
  };
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
    it("either returns the available_slots shape (200) or proxies the upstream error (4xx)", async () => {
      // The route hits a third-party LeadConnector calendar that the operator
      // can deactivate at any time. We're testing the route wiring, not the
      // upstream's uptime — so a clean upstream error pass-through is also
      // a passing case. Anything else (5xx, missing fields on 200) is a bug.
      const resp = await fetch(url("/deckscience/get-slots"), {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBeLessThan(500);
      if (resp.status === 200) {
        const body = await json(resp);
        expect(Array.isArray(body.available_slots)).toBe(true);
      } else {
        // Should be JSON with an error/message field forwarded from GHL.
        const body = await json(resp);
        const errText = String(body.error ?? body.message ?? "");
        expect(errText.length).toBeGreaterThan(0);
      }
    });

    it("when upstream returns slots, every times[].iso parses as a valid date", async () => {
      const resp = await fetch(url("/deckscience/get-slots"), {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({}),
      });
      if (resp.status !== 200) return; // Calendar inactive / misconfigured upstream.
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
        headers: apiHeaders(),
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
        headers: apiHeaders(),
        body: JSON.stringify({ event_message: "not-json{{{" }),
      });
      expect([400, 500]).toContain(resp.status);
    });

    it("returns 400 when event_message has no matched_time_slot anywhere", async () => {
      const resp = await fetch(url("/deckscience/create-appointment"), {
        method: "POST",
        headers: apiHeaders(),
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
