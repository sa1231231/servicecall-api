import { describe, it, expect } from "vitest";
import { generateSlug } from "../slug.js";
describe("generateSlug", () => {
    it("lowercases and slugifies business name", () => {
        const slug = generateSlug("Test Plumbing");
        expect(slug).toMatch(/^test-plumbing-[a-f0-9]{7}$/);
    });
    it("strips special characters", () => {
        const slug = generateSlug("J&A Fleet Maintenance!");
        expect(slug).toMatch(/^j-a-fleet-maintenance-[a-f0-9]{7}$/);
    });
    it("handles leading/trailing special chars", () => {
        const slug = generateSlug("---Test---");
        expect(slug).toMatch(/^test-[a-f0-9]{7}$/);
    });
    it("collapses multiple separators", () => {
        const slug = generateSlug("A   B   C");
        expect(slug).toMatch(/^a-b-c-[a-f0-9]{7}$/);
    });
    it("uses 'agent' prefix for empty name", () => {
        const slug = generateSlug("");
        expect(slug).toMatch(/^agent-[a-f0-9]{7}$/);
    });
    it("uses 'agent' prefix for all-special-chars name", () => {
        const slug = generateSlug("!@#$%");
        expect(slug).toMatch(/^agent-[a-f0-9]{7}$/);
    });
    it("generates unique slugs", () => {
        const a = generateSlug("Test");
        const b = generateSlug("Test");
        expect(a).not.toBe(b);
    });
    it("hash portion is 7 hex characters", () => {
        const slug = generateSlug("Test");
        const hash = slug.split("-").pop();
        expect(hash).toMatch(/^[a-f0-9]{7}$/);
    });
});
