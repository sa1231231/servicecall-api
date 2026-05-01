import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSend, mockGet } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  config: {
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "noreply@test.example",
  },
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockSend, get: mockGet };
  },
}));

// Pass through retry so we assert against the underlying call.
vi.mock("../retry.js", () => ({
  withRetry: (fn: () => Promise<any>) => fn(),
}));

const { sendEmail, getEmailStatus } = await import("../notify-email.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendEmail", () => {
  it("sends with html body when html provided", async () => {
    mockSend.mockResolvedValue({ data: { id: "rs_1" }, error: null });

    const data = await sendEmail({
      to: "user@x.com",
      subject: "hi",
      body: "plain",
      html: "<p>hi</p>",
    });

    expect(mockSend).toHaveBeenCalledWith({
      from: "noreply@test.example",
      to: "user@x.com",
      cc: undefined,
      subject: "hi",
      html: "<p>hi</p>",
    });
    expect(data).toEqual({ id: "rs_1" });
  });

  it("falls back to text body when html is omitted", async () => {
    mockSend.mockResolvedValue({ data: { id: "rs_2" }, error: null });

    await sendEmail({ to: "u@x.com", subject: "s", body: "plain only" });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ text: "plain only" }),
    );
    expect(mockSend.mock.calls[0][0]).not.toHaveProperty("html");
  });

  it("passes cc through when provided", async () => {
    mockSend.mockResolvedValue({ data: { id: "rs_3" }, error: null });

    await sendEmail({ to: "u@x.com", cc: "cc@x.com", subject: "s", body: "b" });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ cc: "cc@x.com" }));
  });

  it("treats null cc as undefined", async () => {
    mockSend.mockResolvedValue({ data: { id: "rs_4" }, error: null });

    await sendEmail({ to: "u@x.com", cc: null, subject: "s", body: "b" });

    expect(mockSend.mock.calls[0][0].cc).toBeUndefined();
  });

  it("throws on resend error", async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: "blocked" } });

    await expect(
      sendEmail({ to: "u@x.com", subject: "s", body: "b" }),
    ).rejects.toThrow("Resend error: blocked");
  });
});

describe("getEmailStatus", () => {
  it("returns the data field on success", async () => {
    mockGet.mockResolvedValue({ data: { id: "rs_x", last_event: "delivered" }, error: null });

    const status = await getEmailStatus("rs_x");

    expect(mockGet).toHaveBeenCalledWith("rs_x");
    expect(status).toEqual({ id: "rs_x", last_event: "delivered" });
  });

  it("throws on error response", async () => {
    mockGet.mockResolvedValue({ data: null, error: { message: "not found" } });

    await expect(getEmailStatus("missing")).rejects.toThrow("Resend error: not found");
  });
});
