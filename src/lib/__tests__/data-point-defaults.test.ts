import { describe, it, expect, vi, beforeEach } from "vitest";
import { DATA_POINT_REGISTRY } from "../agent-generator/data-point-registry.js";

// We test the module's pure logic by verifying the category mapping and
// the shape of data returned, without needing a real MongoDB connection.

describe("data-point-defaults module", () => {
  // ── Category mapping ────────────────────────────────────────────────────

  describe("category mapping", () => {
    const GENERAL_KEYS = [
      "full_name", "phone_number", "email", "street_address",
      "city", "company_name", "scheduling",
    ];
    const TRUCKING_KEYS = [
      "truck_number", "driver_name", "driver_phone", "breakdown_location",
      "problem_description", "vehicle_type", "vehicle_manufacturer",
      "vehicle_color", "whos_paying", "payment_method",
    ];

    it("all general keys exist in DATA_POINT_REGISTRY", () => {
      GENERAL_KEYS.forEach(key => {
        expect(DATA_POINT_REGISTRY[key], `${key} should exist`).toBeDefined();
      });
    });

    it("all trucking keys exist in DATA_POINT_REGISTRY", () => {
      TRUCKING_KEYS.forEach(key => {
        expect(DATA_POINT_REGISTRY[key], `${key} should exist`).toBeDefined();
      });
    });

    it("general + trucking covers all registry keys", () => {
      const allMapped = new Set([...GENERAL_KEYS, ...TRUCKING_KEYS]);
      const registryKeys = Object.keys(DATA_POINT_REGISTRY);
      registryKeys.forEach(key => {
        expect(allMapped.has(key), `${key} should be mapped to a category`).toBe(true);
      });
    });
  });

  // ── Registry data point shape ───────────────────────────────────────────

  describe("registry data points have valid shape for storage", () => {
    it("every registry entry has fields needed for StoredDataPoint", () => {
      Object.entries(DATA_POINT_REGISTRY).forEach(([key, dp]) => {
        expect(dp.label, `${key}.label`).toBeTruthy();
        expect(dp.variableName, `${key}.variableName`).toBe(key);
        expect(typeof dp.type, `${key}.type`).toBe("string");
        expect(dp.conversationPrompt, `${key}.conversationPrompt`).toBeTruthy();
        expect(dp.forwardCondition, `${key}.forwardCondition`).toBeTruthy();
        expect(Array.isArray(dp.extractSuccessEquation), `${key}.extractSuccessEquation`).toBe(true);
        // finetuneExamples can be undefined or array
        if (dp.finetuneExamples !== undefined) {
          expect(Array.isArray(dp.finetuneExamples), `${key}.finetuneExamples`).toBe(true);
        }
      });
    });

    it("finetune examples have valid structure", () => {
      Object.entries(DATA_POINT_REGISTRY).forEach(([key, dp]) => {
        (dp.finetuneExamples || []).forEach((ex, i) => {
          expect(["positive", "negative"], `${key}.finetuneExamples[${i}].type`).toContain(ex.type);
          expect(Array.isArray(ex.transcript), `${key}.finetuneExamples[${i}].transcript`).toBe(true);
          ex.transcript.forEach((t, j) => {
            expect(["user", "agent"], `${key}.ft[${i}].transcript[${j}].role`).toContain(t.role);
            expect(t.content, `${key}.ft[${i}].transcript[${j}].content`).toBeTruthy();
          });
        });
      });
    });
  });

  // ── Data points with finetune examples ──────────────────────────────────

  describe("finetune examples coverage", () => {
    const WITH_EXAMPLES = ["full_name", "phone_number", "driver_phone", "whos_paying", "scheduling"];
    const WITHOUT_EXAMPLES = [
      "email", "street_address", "city", "company_name",
      "truck_number", "driver_name", "breakdown_location", "problem_description",
      "vehicle_type", "vehicle_manufacturer", "vehicle_color", "payment_method",
    ];

    it("data points known to have finetune examples do have them", () => {
      WITH_EXAMPLES.forEach(key => {
        const dp = DATA_POINT_REGISTRY[key];
        expect(dp.finetuneExamples?.length, `${key} should have finetune examples`).toBeGreaterThan(0);
      });
    });

    it("data points known to have empty finetune examples are empty", () => {
      WITHOUT_EXAMPLES.forEach(key => {
        const dp = DATA_POINT_REGISTRY[key];
        expect(dp.finetuneExamples?.length ?? 0, `${key} should have no finetune examples`).toBe(0);
      });
    });

    it("scheduling has the most finetune examples", () => {
      const scheduling = DATA_POINT_REGISTRY.scheduling;
      expect(scheduling.finetuneExamples!.length).toBeGreaterThan(5);
    });

    it("whos_paying has only positive examples", () => {
      const dp = DATA_POINT_REGISTRY.whos_paying;
      dp.finetuneExamples!.forEach(ex => {
        expect(ex.type).toBe("positive");
      });
    });

    it("full_name has a negative example about not asking for last name separately", () => {
      const dp = DATA_POINT_REGISTRY.full_name;
      const neg = dp.finetuneExamples!.find(ex => ex.type === "negative");
      expect(neg).toBeDefined();
      expect(neg!.transcript.some(t => t.content.includes("last name"))).toBe(true);
    });
  });
});
