import { describe, it, expect } from "vitest";
import { areaCodeToTimezone } from "../area-code-timezone.js";
describe("areaCodeToTimezone", () => {
    it.each([
        [212, "America/New_York"], // NYC
        [305, "America/New_York"], // Miami
        [404, "America/New_York"], // Atlanta
        [617, "America/New_York"], // Boston
        [202, "America/New_York"], // DC
    ])("maps Eastern area code %d → %s", (code, expected) => {
        expect(areaCodeToTimezone(code)).toBe(expected);
    });
    it.each([
        [312, "America/Chicago"], // Chicago
        [214, "America/Chicago"], // Dallas
        [713, "America/Chicago"], // Houston
        [615, "America/Chicago"], // Nashville
        [504, "America/Chicago"], // New Orleans
    ])("maps Central area code %d → %s", (code, expected) => {
        expect(areaCodeToTimezone(code)).toBe(expected);
    });
    it.each([
        [303, "America/Denver"], // Denver
        [801, "America/Denver"], // Salt Lake City
        [505, "America/Denver"], // Albuquerque
        [406, "America/Denver"], // Montana
        [208, "America/Denver"], // Idaho (Boise)
    ])("maps Mountain area code %d → %s", (code, expected) => {
        expect(areaCodeToTimezone(code)).toBe(expected);
    });
    it.each([
        [415, "America/Los_Angeles"], // SF
        [213, "America/Los_Angeles"], // LA
        [206, "America/Los_Angeles"], // Seattle
        [702, "America/Los_Angeles"], // Las Vegas
        [503, "America/Los_Angeles"], // Portland
    ])("maps Pacific area code %d → %s", (code, expected) => {
        expect(areaCodeToTimezone(code)).toBe(expected);
    });
    it("returns null for Arizona (no DST, doesn't fit MT)", () => {
        expect(areaCodeToTimezone(602)).toBeNull();
        expect(areaCodeToTimezone(480)).toBeNull();
    });
    it("returns null for Alaska, Hawaii, and Canadian codes", () => {
        expect(areaCodeToTimezone(907)).toBeNull(); // AK
        expect(areaCodeToTimezone(808)).toBeNull(); // HI
        expect(areaCodeToTimezone(416)).toBeNull(); // Toronto
    });
    it("returns null for unknown / invalid input", () => {
        expect(areaCodeToTimezone(0)).toBeNull();
        expect(areaCodeToTimezone(999)).toBeNull();
        expect(areaCodeToTimezone(null)).toBeNull();
        expect(areaCodeToTimezone(undefined)).toBeNull();
        expect(areaCodeToTimezone("abc")).toBeNull();
    });
    it("accepts area code as string", () => {
        expect(areaCodeToTimezone("312")).toBe("America/Chicago");
    });
});
