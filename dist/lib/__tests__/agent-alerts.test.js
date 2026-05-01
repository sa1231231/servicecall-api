import { describe, it, expect, vi } from "vitest";
import { checkAgentAlerts } from "../agent-alerts.js";
// Each test uses a unique agentId to avoid cross-test pollution of the
// module-level call/cost maps inside agent-alerts.
let agentSeq = 0;
function uniqueAgent(prefix) {
    return `${prefix}_${++agentSeq}_${Date.now()}`;
}
describe("checkAgentAlerts — call surge", () => {
    it("does not fire below the 15-call threshold", () => {
        const agentId = uniqueAgent("below");
        let lastResult;
        for (let i = 0; i < 14; i++) {
            lastResult = checkAgentAlerts(agentId);
        }
        expect(lastResult.callSurge.fired).toBe(false);
        expect(lastResult.callSurge.count).toBe(14);
    });
    it("fires when the 15th call lands within the hour", () => {
        const agentId = uniqueAgent("breach");
        let result;
        for (let i = 0; i < 15; i++) {
            result = checkAgentAlerts(agentId);
        }
        expect(result.callSurge.fired).toBe(true);
        expect(result.callSurge.count).toBe(15);
    });
    it("respects the 1-hour cooldown after firing", () => {
        const agentId = uniqueAgent("cooldown");
        let result;
        for (let i = 0; i < 15; i++) {
            result = checkAgentAlerts(agentId);
        }
        expect(result.callSurge.fired).toBe(true);
        // 16th call within the same hour: still over threshold but cooldown blocks re-fire.
        const next = checkAgentAlerts(agentId);
        expect(next.callSurge.count).toBe(16);
        expect(next.callSurge.fired).toBe(false);
    });
    it("re-fires after the cooldown elapses", () => {
        const agentId = uniqueAgent("recooldown");
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
            for (let i = 0; i < 15; i++)
                checkAgentAlerts(agentId);
            // Jump 65 minutes forward — past the 1h window AND cooldown.
            vi.setSystemTime(new Date("2026-01-01T01:05:00Z"));
            // The old timestamps are now stale; need 15 fresh calls in this window.
            let result;
            for (let i = 0; i < 15; i++)
                result = checkAgentAlerts(agentId);
            expect(result.callSurge.fired).toBe(true);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it("trims timestamps older than 1 hour from the sliding window", () => {
        const agentId = uniqueAgent("trim");
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
            for (let i = 0; i < 10; i++)
                checkAgentAlerts(agentId);
            // 90 minutes later, those 10 are stale.
            vi.setSystemTime(new Date("2026-01-01T01:30:00Z"));
            const result = checkAgentAlerts(agentId);
            expect(result.callSurge.count).toBe(1);
            expect(result.callSurge.fired).toBe(false);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it("isolates counts per agentId", () => {
        const a = uniqueAgent("isolA");
        const b = uniqueAgent("isolB");
        for (let i = 0; i < 5; i++)
            checkAgentAlerts(a);
        const resultB = checkAgentAlerts(b);
        expect(resultB.callSurge.count).toBe(1);
    });
});
describe("checkAgentAlerts — cost surge", () => {
    it("does not fire when no callCostCents passed", () => {
        const agentId = uniqueAgent("nocost");
        const result = checkAgentAlerts(agentId);
        expect(result.costSurge.fired).toBe(false);
        expect(result.costSurge.totalCents).toBe(0);
    });
    it("does not fire when callCostCents is zero or negative", () => {
        const agentId = uniqueAgent("zerocost");
        const r1 = checkAgentAlerts(agentId, 0);
        const r2 = checkAgentAlerts(agentId, -5);
        expect(r1.costSurge.fired).toBe(false);
        expect(r1.costSurge.totalCents).toBe(0);
        expect(r2.costSurge.totalCents).toBe(0);
    });
    it("accumulates and fires once at threshold (1000 cents)", () => {
        const agentId = uniqueAgent("accum");
        checkAgentAlerts(agentId, 400); // 400
        const second = checkAgentAlerts(agentId, 400); // 800
        expect(second.costSurge.fired).toBe(false);
        expect(second.costSurge.totalCents).toBe(800);
        const third = checkAgentAlerts(agentId, 300); // 1100, breaches
        expect(third.costSurge.fired).toBe(true);
        expect(third.costSurge.totalCents).toBe(1100);
    });
    it("fires only once per day per agent", () => {
        const agentId = uniqueAgent("oncePerDay");
        checkAgentAlerts(agentId, 1000); // breach
        const second = checkAgentAlerts(agentId, 500);
        expect(second.costSurge.fired).toBe(false);
        expect(second.costSurge.totalCents).toBe(1500);
    });
    it("resets and can re-fire on a new day", () => {
        const agentId = uniqueAgent("newDay");
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
            const day1 = checkAgentAlerts(agentId, 1000);
            expect(day1.costSurge.fired).toBe(true);
            vi.setSystemTime(new Date("2026-01-02T12:00:00Z"));
            const day2 = checkAgentAlerts(agentId, 1000);
            expect(day2.costSurge.fired).toBe(true);
            expect(day2.costSurge.totalCents).toBe(1000);
        }
        finally {
            vi.useRealTimers();
        }
    });
});
describe("checkAgentAlerts — combined", () => {
    it("can fire both call and cost surges in a single call", () => {
        const agentId = uniqueAgent("both");
        // Pre-load 14 calls
        for (let i = 0; i < 14; i++)
            checkAgentAlerts(agentId, 0);
        // 15th call also pushes cost over threshold
        const result = checkAgentAlerts(agentId, 1500);
        expect(result.callSurge.fired).toBe(true);
        expect(result.costSurge.fired).toBe(true);
    });
});
