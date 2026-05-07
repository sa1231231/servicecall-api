import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CreateAgentBody } from "../agent-from-config.js";

// Validation-focused tests for createAgentFromConfig. The body validation
// block (lines 108-172 in agent-from-config.ts) is currently exercised only
// indirectly by the create-agent / from-draft route tests, both of which mock
// the function under test as a black box. These tests call it directly and
// pin every 400 branch to its specific error message.

const { mockNotificationClients, mockGetSettings, mockGenerateAgent } = vi.hoisted(() => ({
  mockNotificationClients: {} as Record<string, unknown>,
  mockGetSettings: vi.fn(),
  mockGenerateAgent: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  config: { RETELL_API_KEY: "test_key" },
}));

vi.mock("../../_cache/clients.js", () => ({
  notificationClients: mockNotificationClients,
  agentIdToClient: {},
  agentIdToSlug: {},
  phoneNumberToClient: {},
}));

vi.mock("../settings.js", () => ({
  getSettings: (...a: any[]) => mockGetSettings(...a),
}));

// Stub everything downstream of validation so that if validation passes, we
// get a deterministic, recognizable failure that's clearly NOT a validation
// error message. This lets us prove "validation accepted this body" without
// pulling in real Retell / Mongo / phone-provisioning code.
vi.mock("retell-sdk", () => ({
  default: class {
    constructor(_opts: any) {}
    conversationFlow = { create: vi.fn().mockRejectedValue(new Error("downstream-stub")) };
    agent = { create: vi.fn().mockRejectedValue(new Error("downstream-stub")) };
  },
}));

vi.mock("../agent-generator/index.js", () => ({
  generateAgent: (...a: any[]) => mockGenerateAgent(...a),
  // The source file imports types from this module — vi.mock replaces the
  // whole module, so re-export empty placeholders to keep TS happy at runtime.
}));

vi.mock("../config/client-store.js", () => ({
  persistClient: vi.fn(),
}));

vi.mock("../provision-number.js", () => ({
  provisionPhoneNumber: vi.fn(),
  extractAreaCode: vi.fn(() => null),
}));

vi.mock("../data-point-defaults.js", () => ({
  getDataPointDefaults: vi.fn().mockResolvedValue({}),
}));

vi.mock("../notification-config.js", () => ({
  toLabel: (k: string, l?: string) => l ?? k,
  deriveNotificationConfig: vi.fn().mockReturnValue({}),
  deriveMultiPathNotificationConfig: vi.fn().mockReturnValue({}),
}));

vi.mock("../retell-sync.js", () => ({
  extractFlowParams: vi.fn().mockReturnValue({}),
  extractAgentParams: vi.fn().mockReturnValue({}),
}));

vi.mock("../area-code-timezone.js", () => ({
  areaCodeToTimezone: vi.fn(() => null),
}));

vi.mock("../agent-generator/warm-transfer-agent-version.js", () => ({
  getWarmTransferAgentVersion: vi.fn(() => null),
}));

const { createAgentFromConfig } = await import("../agent-from-config.js");

// ── Helpers ──────────────────────────────────────────────────────────────

function makeBody(overrides: Partial<CreateAgentBody> = {}): CreateAgentBody {
  const base: CreateAgentBody = {
    business: {
      businessName: "Test HVAC",
      faqKnowledgeBase: "We do HVAC.",
    } as any,
    dataPoints: [{ key: "full_name" } as any],
    client: {
      slug: "test-hvac",
      name: "Test HVAC",
      dispatch_text_numbers: ["+15551234567"],
    },
  };
  // Shallow merge, with deep merge for the two object fields callers tweak most.
  return {
    ...base,
    ...overrides,
    business: { ...base.business, ...(overrides.business ?? {}) } as any,
    client: { ...base.client, ...(overrides.client ?? {}) },
  };
}

beforeEach(() => {
  for (const k of Object.keys(mockNotificationClients)) delete mockNotificationClients[k];
  mockGetSettings.mockReset();
  mockGenerateAgent.mockReset();
  // Default: settings have no owner_phone (forces the explicit-rejection path
  // unless the test overrides). Tests that need a fallback set it explicitly.
  mockGetSettings.mockResolvedValue({ owner_phone: null });
});

// ── Required-field rejections ────────────────────────────────────────────

describe("createAgentFromConfig — required fields", () => {
  it("rejects when business.businessName is missing", async () => {
    const body = makeBody({ business: { faqKnowledgeBase: "x" } as any });
    delete (body.business as any).businessName;
    const result = await createAgentFromConfig(body);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      status: 400,
      error: expect.stringContaining("business.businessName"),
    });
  });

  it("rejects when faqKnowledgeBase is missing", async () => {
    const body = makeBody({ business: { businessName: "X" } as any });
    delete (body.business as any).faqKnowledgeBase;
    const result = await createAgentFromConfig(body);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("faqKnowledgeBase"),
    });
  });

  it("rejects when neither dataPoints nor paths are provided", async () => {
    const body = makeBody();
    delete body.dataPoints;
    const result = await createAgentFromConfig(body);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("dataPoints"),
    });
  });

  it("rejects when both dataPoints and paths are empty", async () => {
    const body = makeBody({ dataPoints: [], paths: [] });
    const result = await createAgentFromConfig(body);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("non-empty"),
    });
  });

  it("rejects when client.slug is missing", async () => {
    const body = makeBody({ client: { slug: "", name: "X", dispatch_text_numbers: ["+15551234567"] } });
    const result = await createAgentFromConfig(body);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("client.slug"),
    });
  });

  it("rejects when client.name is missing", async () => {
    const body = makeBody();
    delete (body.client as any).name;
    const result = await createAgentFromConfig(body);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("client.name"),
    });
  });

  it("rejects when client.name is whitespace-only", async () => {
    const body = makeBody({ client: { slug: "x", name: "   ", dispatch_text_numbers: ["+15551234567"] } });
    const result = await createAgentFromConfig(body);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("client.name"),
    });
  });
});

// ── Per-path validation ──────────────────────────────────────────────────

describe("createAgentFromConfig — paths validation", () => {
  function pathsBody(paths: any[]): CreateAgentBody {
    const body = makeBody({ paths });
    delete body.dataPoints;
    return body;
  }

  it("rejects path with empty name", async () => {
    const result = await createAgentFromConfig(pathsBody([
      { name: "", transitionCondition: "x", dataPoints: [] },
    ]));
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("paths[0].name"),
    });
  });

  it("rejects path with empty transitionCondition", async () => {
    const result = await createAgentFromConfig(pathsBody([
      { name: "service", transitionCondition: "", dataPoints: [] },
    ]));
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("transitionCondition"),
    });
  });

  it("rejects path whose dataPoints is not an array", async () => {
    const result = await createAgentFromConfig(pathsBody([
      { name: "service", transitionCondition: "x", dataPoints: "not-an-array" as any },
    ]));
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("must be an array"),
    });
  });

  it("rejects path with invalid end_mode", async () => {
    const result = await createAgentFromConfig(pathsBody([
      { name: "service", transitionCondition: "x", dataPoints: [], end_mode: "warp" as any },
    ]));
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining('"callback" or "transfer"'),
    });
  });

  it("rejects path with end_mode=transfer when no dispatch_call_number is set", async () => {
    const result = await createAgentFromConfig(pathsBody([
      { name: "service", transitionCondition: "x", dataPoints: [], end_mode: "transfer" },
    ]));
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("transfer"),
    });
    if (result.ok === false) {
      expect(result.error).toMatch(/no dispatch call number/);
    }
  });

  it("accepts end_mode=transfer when a per-path dispatch number is set", async () => {
    const body = pathsBody([
      { name: "service", transitionCondition: "x", dataPoints: [], end_mode: "transfer" },
    ]);
    body.client.dispatch_by_type = {
      service: { dispatch_call_number: "+15559998888" },
    };
    const result = await createAgentFromConfig(body);
    // Validation passes → flow proceeds to the Retell SDK stub which throws
    // "downstream-stub". So the error must NOT be a validation message.
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).not.toMatch(/no dispatch call number/);
      expect(result.error).not.toMatch(/end_mode/);
    }
  });

  it("accepts end_mode=transfer when client-level dispatch_call_number is set", async () => {
    const body = pathsBody([
      { name: "service", transitionCondition: "x", dataPoints: [], end_mode: "transfer" },
    ]);
    body.client.dispatch_call_number = "+15559998888";
    const result = await createAgentFromConfig(body);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).not.toMatch(/no dispatch call number/);
    }
  });
});

// ── Owner-phone fallback ─────────────────────────────────────────────────

describe("createAgentFromConfig — dispatch_text_numbers fallback", () => {
  it("rejects when dispatch_text_numbers is empty AND no owner_phone in settings", async () => {
    mockGetSettings.mockResolvedValue({ owner_phone: null });
    const body = makeBody({ client: { slug: "x", name: "X", dispatch_text_numbers: [] } });
    const result = await createAgentFromConfig(body);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("owner phone"),
    });
  });

  it("falls back to settings.owner_phone when dispatch_text_numbers is empty", async () => {
    mockGetSettings.mockResolvedValue({ owner_phone: "+15550000000" });
    const body = makeBody({ client: { slug: "x", name: "X", dispatch_text_numbers: [] } });
    const result = await createAgentFromConfig(body);
    // Validation passed; downstream (Retell stub) rejects.
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).not.toMatch(/owner phone/);
      expect(result.error).not.toMatch(/dispatch_text_numbers/);
    }
    // The settings fallback must have been queried.
    expect(mockGetSettings).toHaveBeenCalled();
  });
});

// ── Slug collision ───────────────────────────────────────────────────────

describe("createAgentFromConfig — slug collision", () => {
  it("appends -2 when the requested slug is already taken", async () => {
    mockNotificationClients["taken"] = { name: "existing" };
    const body = makeBody({ client: { slug: "taken", name: "X", dispatch_text_numbers: ["+15551234567"] } });
    await createAgentFromConfig(body);
    // Validation block mutates body.client.slug if a collision is detected.
    expect(body.client.slug).toBe("taken-2");
  });

  it("walks up to -3, -4, ... if subsequent slugs are also taken", async () => {
    mockNotificationClients["taken"] = { name: "a" };
    mockNotificationClients["taken-2"] = { name: "b" };
    mockNotificationClients["taken-3"] = { name: "c" };
    const body = makeBody({ client: { slug: "taken", name: "X", dispatch_text_numbers: ["+15551234567"] } });
    await createAgentFromConfig(body);
    expect(body.client.slug).toBe("taken-4");
  });

  it("leaves slug untouched when there is no collision", async () => {
    const body = makeBody({ client: { slug: "fresh-slug", name: "X", dispatch_text_numbers: ["+15551234567"] } });
    await createAgentFromConfig(body);
    expect(body.client.slug).toBe("fresh-slug");
  });
});
