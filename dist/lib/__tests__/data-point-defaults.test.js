import { describe, it, expect } from "vitest";
import { NOT_MENTIONED, CALLER_DOESNT_KNOW, PHONE_COLLECTED_FLAG, PATH_TAKEN_VAR, INTERNAL_VARS, defaultExtractEquation, } from "../agent-generator/data-point-registry.js";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../data-point-defaults.js";
// Data points now live in MongoDB. These tests validate the types,
// constants, and helpers that remain in code.
describe("data-point-registry constants and helpers", () => {
    it("NOT_MENTIONED is 'Not Mentioned'", () => {
        expect(NOT_MENTIONED).toBe("Not Mentioned");
    });
    it("CALLER_DOESNT_KNOW is \"Caller Doesn't Know\"", () => {
        expect(CALLER_DOESNT_KNOW).toBe("Caller Doesn't Know");
    });
    it("PHONE_COLLECTED_FLAG is 'phone_number_collected'", () => {
        expect(PHONE_COLLECTED_FLAG).toBe("phone_number_collected");
    });
    it("PATH_TAKEN_VAR is '_path_taken'", () => {
        expect(PATH_TAKEN_VAR).toBe("_path_taken");
    });
    it("INTERNAL_VARS contains both internal variable names", () => {
        expect(INTERNAL_VARS.has(PHONE_COLLECTED_FLAG)).toBe(true);
        expect(INTERNAL_VARS.has(PATH_TAKEN_VAR)).toBe(true);
        expect(INTERNAL_VARS.size).toBe(2);
    });
    it("defaultExtractEquation generates correct equations", () => {
        const eqs = defaultExtractEquation("test_var");
        expect(eqs).toHaveLength(2);
        expect(eqs[0]).toEqual({ left: "{{test_var}}", operator: "exists" });
        expect(eqs[1]).toEqual({ left: "{{test_var}}", operator: "!=", right: NOT_MENTIONED });
    });
});
describe("category configuration", () => {
    it("CATEGORY_ORDER has expected categories", () => {
        expect(CATEGORY_ORDER).toContain("caller_info");
        expect(CATEGORY_ORDER).toContain("trucking");
        expect(CATEGORY_ORDER).toContain("billing");
        expect(CATEGORY_ORDER).toContain("legal_intake");
        expect(CATEGORY_ORDER.length).toBeGreaterThanOrEqual(9);
    });
    it("every category in CATEGORY_ORDER has a label", () => {
        for (const cat of CATEGORY_ORDER) {
            expect(CATEGORY_LABELS[cat], `${cat} should have a label`).toBeTruthy();
        }
    });
});
