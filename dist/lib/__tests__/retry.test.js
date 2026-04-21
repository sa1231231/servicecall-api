import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../retry.js";
describe("withRetry", () => {
    it("returns result on first success", async () => {
        const fn = vi.fn().mockResolvedValue("ok");
        const result = await withRetry(fn, { label: "test" });
        expect(result).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
    });
    it("retries on failure and succeeds", async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error("fail1"))
            .mockResolvedValue("ok");
        const result = await withRetry(fn, {
            label: "test",
            baseDelayMs: 1,
        });
        expect(result).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(2);
    });
    it("throws after exhausting all attempts", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("always fails"));
        await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, label: "test" })).rejects.toThrow("always fails");
        expect(fn).toHaveBeenCalledTimes(3);
    });
    it("uses exponential backoff between retries", async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error("fail1"))
            .mockRejectedValueOnce(new Error("fail2"))
            .mockResolvedValue("ok");
        const start = Date.now();
        await withRetry(fn, { maxAttempts: 3, baseDelayMs: 50, label: "test" });
        const elapsed = Date.now() - start;
        // First retry: 50ms, second retry: 100ms → at least ~150ms total
        expect(elapsed).toBeGreaterThanOrEqual(100);
        expect(fn).toHaveBeenCalledTimes(3);
    });
    it("defaults to 3 attempts", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("fail"));
        await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow();
        expect(fn).toHaveBeenCalledTimes(3);
    });
});
