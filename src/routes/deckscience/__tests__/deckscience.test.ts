import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../../config.js", () => ({ config: { GHL_API_KEY: "ghl_test_key" } }));

const { createAppointmentHandler } = await import("../create-appointment.js");
const { getSlotsHandler } = await import("../get-slots.js");

function makeRes(): Response & { _status: number; _json: any; _data: any } {
  const res: any = { _status: 200, _json: null, _data: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  res.send = (data: any) => { res._data = data; return res; };
  return res;
}

function makeReq(body: any = {}): Request {
  return { body } as any;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

// ── createAppointmentHandler ───────────────────────────────────────────────

describe("createAppointmentHandler", () => {
  it("returns 400 when no matched_time_slot in vars", async () => {
    const res = makeRes();
    await createAppointmentHandler(makeReq({}), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/iso/);
  });

  it("parses event_message string from Retell wrapper", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"event_id":"evt_1"}',
    });
    const res = makeRes();
    const eventMessage = JSON.stringify({
      call: {
        collected_dynamic_variables: {
          matched_time_slot: "2026-06-01T15:00:00.000Z",
          physical_address: "123 Main St",
        },
      },
    });
    await createAppointmentHandler(makeReq({ event_message: eventMessage }), res);
    expect(res._status).toBe(200);
    expect(res._data).toBe('{"event_id":"evt_1"}');
    const fetchCall = fetchMock.mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);
    expect(payload.startTime).toBe("2026-06-01T15:00:00.000Z");
    // 90-min duration
    expect(payload.endTime).toBe("2026-06-01T16:30:00.000Z");
    expect(payload.address).toBe("123 Main St");
  });

  it("falls back to dynamic_variables when collected is empty", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, text: async () => "{}",
    });
    const res = makeRes();
    await createAppointmentHandler(makeReq({
      call: {
        retell_llm_dynamic_variables: { matched_time_slot: "2026-06-01T15:00:00.000Z" },
      },
    }), res);
    expect(res._status).toBe(200);
  });

  it("uses default contact_id when none provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, text: async () => "{}",
    });
    const res = makeRes();
    await createAppointmentHandler(makeReq({
      call: { collected_dynamic_variables: { matched_time_slot: "2026-06-01T15:00:00.000Z" } },
    }), res);
    expect(res._status).toBe(200);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.contactId).toBe("cgyF4ZXTnW2VQDzRCWpA");
  });

  it("propagates non-OK status from GHL", async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 422, text: async () => '{"error":"slot taken"}',
    });
    const res = makeRes();
    await createAppointmentHandler(makeReq({
      call: { collected_dynamic_variables: { matched_time_slot: "2026-06-01T15:00:00.000Z" } },
    }), res);
    expect(res._status).toBe(422);
    expect(res._data).toBe('{"error":"slot taken"}');
  });

  it("returns 500 when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("net down"));
    const res = makeRes();
    await createAppointmentHandler(makeReq({
      call: { collected_dynamic_variables: { matched_time_slot: "2026-06-01T15:00:00.000Z" } },
    }), res);
    expect(res._status).toBe(500);
  });

  it("returns 500 when event_message is invalid JSON", async () => {
    const res = makeRes();
    await createAppointmentHandler(makeReq({ event_message: "not json{" }), res);
    expect(res._status).toBe(500);
  });
});

// ── getSlotsHandler ────────────────────────────────────────────────────────

describe("getSlotsHandler", () => {
  it("calls GHL with correct query params and parses response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        traceId: "abc",
        "2026-06-01": { slots: ["2026-06-01T15:00:00.000Z", "2026-06-01T16:00:00.000Z"] },
        "2026-06-02": { slots: [] }, // skipped (empty)
      }),
    });

    const res = makeRes();
    await getSlotsHandler(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._json.available_slots).toHaveLength(1);
    const day = res._json.available_slots[0];
    expect(day.times).toHaveLength(2);
    expect(day.times[0].iso).toBe("2026-06-01T15:00:00.000Z");
    expect(typeof day.times[0].display).toBe("string");

    // Verify request URL includes calendar ID and timezone
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain("/calendars/xxCyQ9oSNEGdgFjIpMlC/free-slots");
    expect(calledUrl).toContain("timezone=America%2FChicago");
  });

  it("propagates non-OK GHL status", async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 401,
      json: async () => ({ message: "unauthorized" }),
    });
    const res = makeRes();
    await getSlotsHandler(makeReq(), res);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ message: "unauthorized" });
  });

  it("returns 500 when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("net down"));
    const res = makeRes();
    await getSlotsHandler(makeReq(), res);
    expect(res._status).toBe(500);
  });

  it("skips entries with non-array slot values", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        "2026-06-01": { slots: "not-an-array" },
        "2026-06-02": { slots: ["2026-06-02T15:00:00.000Z"] },
      }),
    });
    const res = makeRes();
    await getSlotsHandler(makeReq(), res);
    expect(res._json.available_slots).toHaveLength(1);
    expect(res._json.available_slots[0].times).toHaveLength(1);
  });
});
