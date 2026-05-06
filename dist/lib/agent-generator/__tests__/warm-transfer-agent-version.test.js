import { describe, it, expect, vi, beforeEach } from "vitest";
import { getWarmTransferAgentVersion, _resetWarmTransferAgentVersionCache, } from "../warm-transfer-agent-version.js";
import { WARM_TRANSFER_AGENT_VERSION_FALLBACK } from "../node-builders.js";
function makeRetell(retrieve) {
    return { agent: { retrieve: vi.fn(retrieve) } };
}
beforeEach(() => {
    _resetWarmTransferAgentVersionCache();
});
describe("getWarmTransferAgentVersion", () => {
    it("returns version from Retell when valid", async () => {
        const r = makeRetell(async () => ({ version: 7 }));
        const v = await getWarmTransferAgentVersion(r);
        expect(v).toBe(7);
    });
    it("caches the result for repeated calls within TTL", async () => {
        const r = makeRetell(async () => ({ version: 9 }));
        const v1 = await getWarmTransferAgentVersion(r);
        const v2 = await getWarmTransferAgentVersion(r);
        expect(v1).toBe(9);
        expect(v2).toBe(9);
        expect(r.agent.retrieve).toHaveBeenCalledTimes(1);
    });
    it("returns fallback when Retell throws", async () => {
        const r = makeRetell(async () => { throw new Error("not found"); });
        const v = await getWarmTransferAgentVersion(r);
        expect(v).toBe(WARM_TRANSFER_AGENT_VERSION_FALLBACK);
    });
    it("returns fallback when version is invalid (NaN, zero, negative, missing)", async () => {
        for (const bad of [NaN, 0, -1, undefined, "string"]) {
            _resetWarmTransferAgentVersionCache();
            const r = makeRetell(async () => ({ version: bad }));
            const v = await getWarmTransferAgentVersion(r);
            expect(v).toBe(WARM_TRANSFER_AGENT_VERSION_FALLBACK);
        }
    });
    it("does not cache fallback values — retries on next call", async () => {
        let calls = 0;
        const retrieve = vi.fn(async () => {
            calls++;
            if (calls === 1)
                throw new Error("transient");
            return { version: 11 };
        });
        const r = { agent: { retrieve } };
        const v1 = await getWarmTransferAgentVersion(r);
        expect(v1).toBe(WARM_TRANSFER_AGENT_VERSION_FALLBACK);
        const v2 = await getWarmTransferAgentVersion(r);
        expect(v2).toBe(11);
        expect(retrieve).toHaveBeenCalledTimes(2);
    });
});
