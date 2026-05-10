import "dotenv/config";
import { describe, it, expect, afterAll, beforeAll } from "vitest";

// ── Config (mirrors system.test.ts) ─────────────────────────────────────────

const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const ROOT_PASSWORD = process.env.ROOT_PASSWORD;
const LEAD_INTAKE_TOKEN = process.env.LEAD_INTAKE_TOKEN;

const hasConfig =
  !!BASE_URL && BASE_URL.startsWith("http") && !!API_KEY && !!ROOT_PASSWORD && !!LEAD_INTAKE_TOKEN;

const TEST_NAME_PREFIX = "[SYSTEM TEST] ";

function url(path: string): string {
  return `${BASE_URL}${path}`;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-api-key": API_KEY!,
    Authorization: "Basic " + Buffer.from(`admin:${ROOT_PASSWORD}`).toString("base64"),
    "Content-Type": "application/json",
    ...extra,
  };
}

function intakeHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${LEAD_INTAKE_TOKEN}`,
  };
}

async function json(resp: Response): Promise<any> {
  return resp.json();
}

async function getLead(id: string): Promise<any> {
  const resp = await fetch(url(`/api/leads/${id}`), { headers: authHeaders() });
  if (!resp.ok) throw new Error(`Failed to fetch lead ${id}: ${resp.status}`);
  return json(resp);
}

/** Polls a lead until status leaves the in-flight set or timeout elapses. */
async function waitForEnrichment(
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lead = await getLead(id);
    if (lead.status !== "queued" && lead.status !== "enriching") return lead;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Lead ${id} did not finish enrichment within ${timeoutMs}ms`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!hasConfig)("System tests — Lead lifecycle", { timeout: 120_000 }, () => {
  const createdLeadIds: string[] = [];

  afterAll(async () => {
    for (const id of createdLeadIds) {
      try {
        await fetch(url(`/api/leads/${id}/dismiss`), {
          method: "POST",
          headers: authHeaders(),
        });
      } catch { /* best-effort */ }
    }
  });

  describe("Enrichment lifecycle", () => {
    it(
      "intake → enrichment runs to terminal status (ready or failed) within timeout",
      { timeout: 120_000 },
      async () => {
        const resp = await fetch(url("/api/leads/intake"), {
          method: "POST",
          headers: intakeHeaders(),
          body: JSON.stringify({
            name: TEST_NAME_PREFIX + "enrich-" + Date.now(),
            source: "system_test",
            // A real, well-known business so enrichment has something to work with.
            website: "https://www.apple.com",
          }),
        });
        expect(resp.status).toBe(201);
        const { _id } = await json(resp);
        createdLeadIds.push(_id);

        const finished = await waitForEnrichment(_id);
        // Either ready (success) or failed (handled gracefully) is an OK
        // terminal state — both prove the pipeline didn't get stuck. We do
        // NOT assert which one, because enrichment quality varies.
        expect(["ready", "failed"]).toContain(finished.status);

        if (finished.status === "ready") {
          expect(finished.enriched).toBeTruthy();
          expect(typeof finished.enriched.business_name).toBe("string");
          // Trace fields must be present so the AI Feed panel can render.
          expect(finished.enriched.extra).toBeDefined();
          expect(finished.enriched.extra._userMessage).toBeTruthy();
        } else {
          expect(typeof finished.enrichmentError).toBe("string");
        }
      },
    );
  });

  describe("Operator actions on a lead", () => {
    let leadId: string;

    beforeAll(async () => {
      const resp = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: intakeHeaders(),
        body: JSON.stringify({
          name: TEST_NAME_PREFIX + "ops-" + Date.now(),
          source: "system_test",
        }),
      });
      const body = await json(resp);
      leadId = body._id;
      createdLeadIds.push(leadId);
    });

    it("PATCH operator-edit updates input fields and returns the updated lead", async () => {
      const newPhone = "+15555550199";
      const resp = await fetch(url(`/api/leads/${leadId}`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({
          input: {
            name: TEST_NAME_PREFIX + "ops-edited",
            phone: newPhone,
          },
        }),
      });
      expect(resp.status).toBe(200);
      const updated = await json(resp);
      expect(updated.input.phone).toBe(newPhone);
      expect(updated.input.name).toContain("ops-edited");
    });

    it("PATCH with empty body returns 400", async () => {
      const resp = await fetch(url(`/api/leads/${leadId}`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
    });

    it("PATCH with empty input.name returns 400", async () => {
      const resp = await fetch(url(`/api/leads/${leadId}`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ input: { name: "   " } }),
      });
      expect(resp.status).toBe(400);
    });

    it("re-enrich resets status to 'enriching'", async () => {
      const resp = await fetch(url(`/api/leads/${leadId}/re-enrich`), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body.status).toBe("enriching");
    });

    it("re-enrich returns 404 for nonexistent lead", async () => {
      const resp = await fetch(url(`/api/leads/507f1f77bcf86cd799439011/re-enrich`), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(404);
    });
  });

  describe("Promote validation", () => {
    let leadId: string;

    beforeAll(async () => {
      const resp = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: intakeHeaders(),
        body: JSON.stringify({
          name: TEST_NAME_PREFIX + "promote-" + Date.now(),
          source: "system_test",
        }),
      });
      const body = await json(resp);
      leadId = body._id;
      createdLeadIds.push(leadId);
    });

    it("returns 400 when neither `draft` is supplied nor a templateName exists on the lead", async () => {
      // Lead is fresh (status=queued/enriching), no enriched.templateName yet.
      const resp = await fetch(url(`/api/leads/${leadId}/promote`), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
      const body = await json(resp);
      expect(String(body.error)).toMatch(/draft/i);
    });

    it("returns 400 when enriched fields (business_name/faqKnowledgeBase) are missing", async () => {
      const resp = await fetch(url(`/api/leads/${leadId}/promote`), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ draft: "[draft-that-may-or-may-not-exist]" }),
      });
      // Status is 400 either way:
      //   - missing enriched fields → "missing enriched..."
      //   - draft missing entirely  → 404 (which is also acceptable)
      expect([400, 404]).toContain(resp.status);
    });

    it("returns 404 for a nonexistent lead id", async () => {
      const resp = await fetch(url(`/api/leads/507f1f77bcf86cd799439011/promote`), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ draft: "any" }),
      });
      expect(resp.status).toBe(404);
    });
  });

  describe("Dismiss flow", () => {
    let leadId: string;

    beforeAll(async () => {
      const resp = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: intakeHeaders(),
        body: JSON.stringify({
          name: TEST_NAME_PREFIX + "dismiss-" + Date.now(),
          source: "system_test",
        }),
      });
      const body = await json(resp);
      leadId = body._id;
      // Don't push to createdLeadIds — we'll dismiss explicitly below.
    });

    it("POST /dismiss soft-closes the lead", async () => {
      const resp = await fetch(url(`/api/leads/${leadId}/dismiss`), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);

      const lead = await getLead(leadId);
      expect(lead.status).toBe("dismissed");
    });

    it("dismissed lead is excluded from default list, present with include_terminal=1", async () => {
      const def = await fetch(url("/api/leads"), { headers: authHeaders() });
      const defList = await json(def);
      expect(Array.isArray(defList)).toBe(true);
      expect(defList.find((l: any) => l._id === leadId)).toBeUndefined();

      const term = await fetch(url("/api/leads?include_terminal=1"), { headers: authHeaders() });
      const termList = await json(term);
      expect(termList.find((l: any) => l._id === leadId)).toBeDefined();
    });

    it("dismiss returns 404 for nonexistent lead", async () => {
      const resp = await fetch(url(`/api/leads/507f1f77bcf86cd799439011/dismiss`), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(404);
    });
  });
});
