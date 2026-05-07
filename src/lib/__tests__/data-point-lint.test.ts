import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { lintDataPoint, lintBranchVariableReferences, type LintError } from "../data-point-lint.js";
import {
  CALLER_DOESNT_KNOW,
  defaultExtractEquation,
  NOT_MENTIONED,
  type DataPoint,
} from "../agent-generator/data-point-registry.js";

function goodString(name: string): DataPoint {
  return {
    label: name,
    variableName: name,
    type: "string",
    description: `${name}. If not mentioned, set to "${NOT_MENTIONED}". If they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask for ${name}. If they don't know, move on.`,
    forwardCondition: `Caller has provided ${name} or said they don't know`,
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation(name),
  };
}

function goodEnum(): DataPoint {
  return {
    label: "Vehicle Type",
    variableName: "vehicle_type",
    type: "enum",
    choices: ["Semi", "Box truck", CALLER_DOESNT_KNOW, NOT_MENTIONED],
    description: `Vehicle type. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask what type of truck.",
    forwardCondition: "Caller has provided vehicle type",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("vehicle_type"),
  };
}

function goodComposite(): DataPoint {
  return {
    composite: true,
    label: "Scheduling",
    variableName: "scheduling",
    type: "string",
    description: "",
    variables: [
      {
        variableName: "preferred_day",
        type: "enum",
        choices: ["Monday", CALLER_DOESNT_KNOW, NOT_MENTIONED],
        description: "Day preference",
      },
      {
        variableName: "preferred_time",
        type: "enum",
        choices: ["Morning", NOT_MENTIONED],
        description: "Time preference",
      },
    ],
    conversationPrompt: "Ask when they want someone to come out.",
    forwardCondition: "Caller has agreed to a day and time",
    finetuneExamples: [],
    extractSuccessEquation: [],
  };
}

describe("lintDataPoint", () => {
  describe("string data points", () => {
    it("passes a well-formed data point", () => {
      expect(lintDataPoint(goodString("full_name"))).toEqual([]);
    });

    it("flags empty description", () => {
      const dp = goodString("full_name");
      dp.description = "";
      const errors = lintDataPoint(dp);
      expect(errors.map((e) => e.code)).toContain("NO_DESCRIPTION");
    });

    it("flags description missing sentinel handling", () => {
      const dp = goodString("full_name");
      dp.description = "Just the caller's name.";
      const errors = lintDataPoint(dp);
      expect(errors.map((e) => e.code)).toContain("DESCRIPTION_MISSING_SENTINEL");
    });

    it("flags missing conversationPrompt", () => {
      const dp = goodString("full_name");
      dp.conversationPrompt = "";
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("NO_CONVERSATION_PROMPT");
    });

    it("flags missing forwardCondition", () => {
      const dp = goodString("full_name");
      dp.forwardCondition = "";
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("NO_FORWARD_CONDITION");
    });

    it("flags empty extractSuccessEquation", () => {
      const dp = goodString("full_name");
      dp.extractSuccessEquation = [];
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("NO_EXTRACT_EQUATION");
    });

    it("flags extractSuccessEquation that doesn't reference its own variable", () => {
      const dp = goodString("full_name");
      dp.extractSuccessEquation = [{ left: "{{some_other_var}}", operator: "exists" }];
      expect(lintDataPoint(dp).map((e) => e.code)).toContain(
        "EXTRACT_EQUATION_DOES_NOT_REFERENCE_SELF",
      );
    });

    it("does not flag conversationPrompt for orphan extract-only data points", () => {
      const dp = goodString("passive_var");
      dp.orphan = true;
      dp.conversationPrompt = "";
      expect(lintDataPoint(dp).map((e) => e.code)).not.toContain("NO_CONVERSATION_PROMPT");
    });
  });

  describe("enum data points", () => {
    it("passes a well-formed enum", () => {
      expect(lintDataPoint(goodEnum())).toEqual([]);
    });

    it("flags missing choices", () => {
      const dp = goodEnum();
      dp.choices = [];
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("ENUM_NO_CHOICES");
    });

    it("flags choices missing NOT_MENTIONED sentinel", () => {
      const dp = goodEnum();
      dp.choices = ["Semi", "Box truck"];
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("ENUM_MISSING_NOT_MENTIONED");
    });

    it("flags duplicate choices", () => {
      const dp = goodEnum();
      dp.choices = ["Semi", "Semi", NOT_MENTIONED];
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("ENUM_DUPLICATE_CHOICE");
    });
  });

  describe("composite data points", () => {
    it("passes a well-formed composite", () => {
      expect(lintDataPoint(goodComposite())).toEqual([]);
    });

    it("flags composite with no nested variables", () => {
      const dp = goodComposite();
      dp.variables = [];
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("COMPOSITE_NO_VARIABLES");
    });

    it("flags composite with non-empty extractSuccessEquation", () => {
      const dp = goodComposite();
      dp.extractSuccessEquation = defaultExtractEquation("scheduling");
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("COMPOSITE_HAS_EXTRACT_EQUATION");
    });

    it("flags composite variable with missing description", () => {
      const dp = goodComposite();
      dp.variables![0].description = "";
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("COMPOSITE_VAR_NO_DESCRIPTION");
    });

    it("flags composite variable enum with no NOT_MENTIONED choice", () => {
      const dp = goodComposite();
      dp.variables![0].choices = ["Monday", "Tuesday"];
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("ENUM_MISSING_NOT_MENTIONED");
    });

    it("flags duplicate composite variable names", () => {
      const dp = goodComposite();
      dp.variables![1].variableName = "preferred_day";
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("COMPOSITE_VAR_DUPLICATE");
    });
  });

  describe("finetune examples", () => {
    it("flags invalid type", () => {
      const dp = goodString("full_name");
      dp.finetuneExamples = [
        { type: "wrong" as any, transcript: [{ content: "x", role: "user" }] },
      ];
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("FINETUNE_INVALID_TYPE");
    });

    it("flags empty transcript", () => {
      const dp = goodString("full_name");
      dp.finetuneExamples = [{ type: "positive", transcript: [] }];
      expect(lintDataPoint(dp).map((e) => e.code)).toContain("FINETUNE_EMPTY_TRANSCRIPT");
    });
  });
});

describe("lintBranchVariableReferences", () => {
  it("passes when branches reference extracted variables", () => {
    const flow = {
      nodes: [
        {
          id: "extract1",
          type: "extract_dynamic_variables",
          variables: [{ name: "service_type" }],
        },
        {
          id: "branch1",
          type: "branch",
          name: "Service Router",
          edges: [
            {
              transition_condition: {
                type: "equation",
                equations: [{ left: "{{service_type}}", operator: "==", right: "Repair" }],
              },
            },
          ],
        },
      ],
    };
    expect(lintBranchVariableReferences(flow)).toEqual([]);
  });

  it("flags branches that reference unknown variables", () => {
    const flow = {
      nodes: [
        {
          id: "branch1",
          type: "branch",
          name: "Bad Router",
          edges: [
            {
              transition_condition: {
                type: "equation",
                equations: [{ left: "{{ghost_var}}", operator: "==", right: "x" }],
              },
            },
          ],
        },
      ],
    };
    const errors = lintBranchVariableReferences(flow);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("BRANCH_REFERENCES_UNKNOWN_VARIABLE");
    expect(errors[0].variableName).toBe("ghost_var");
  });
});

// ── Deployed defaults (env-gated on MONGODB_URL) ─────────────────────────────

const MONGODB_URL = process.env.MONGODB_URL;
// Treat CI-stub MONGODB_URLs as "no live DB" so this suite skips in CI.
// `src/config.ts` requires MONGODB_URL via requireEnv() at module load,
// so the workflow has to provide *some* value — but the value contains
// "ci-stub" specifically to mark it as inert.
const HAS_LIVE_DB = !!MONGODB_URL && !MONGODB_URL.includes("ci-stub");

describe.skipIf(!HAS_LIVE_DB)("Deployed data point defaults (live MongoDB)", () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URL!);
    await client.connect();
    db = client.db();
  });

  afterAll(async () => {
    await client?.close();
  });

  it("every deployed data point default lints clean", async () => {
    const docs = await db
      .collection<DataPoint & { _id: string }>("data_point_defaults")
      .find({})
      .toArray();
    expect(docs.length, "expected at least one data point default in MongoDB").toBeGreaterThan(0);

    const errorsByVar: Record<string, LintError[]> = {};
    for (const doc of docs) {
      const { _id, ...dp } = doc as any;
      // Some legacy docs may lack variableName — fall back to _id
      if (!dp.variableName) dp.variableName = _id;
      const errors = lintDataPoint(dp as DataPoint);
      if (errors.length > 0) errorsByVar[dp.variableName] = errors;
    }

    if (Object.keys(errorsByVar).length > 0) {
      const lines: string[] = ["Deployed data point lint errors:"];
      for (const [varName, errs] of Object.entries(errorsByVar)) {
        lines.push(`  ${varName}:`);
        for (const e of errs) lines.push(`    [${e.code}] ${e.message}`);
      }
      throw new Error(lines.join("\n"));
    }
  });

  it("every deployed agent's canonical flow has no dangling branch variable references", async () => {
    const versions = db.collection<{ slug: string; agentId: string; version: number; canonicalJson: any }>("agent_versions");
    // Get the latest version per (slug, agentId) pair
    const latest = await versions
      .aggregate([
        { $sort: { version: -1 } },
        { $group: { _id: { slug: "$slug", agentId: "$agentId" }, doc: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$doc" } },
      ])
      .toArray();

    if (latest.length === 0) {
      console.warn("[lint] No agent_versions found — skipping flow lint");
      return;
    }

    const errorsByAgent: Record<string, LintError[]> = {};
    for (const v of latest) {
      const flow = v.canonicalJson?.conversationFlow ?? v.canonicalJson;
      if (!flow || !Array.isArray(flow.nodes)) continue;
      const errors = lintBranchVariableReferences(flow);
      if (errors.length > 0) errorsByAgent[`${v.slug}/${v.agentId}`] = errors;
    }

    if (Object.keys(errorsByAgent).length > 0) {
      const lines: string[] = ["Branch variable lint errors per agent:"];
      for (const [key, errs] of Object.entries(errorsByAgent)) {
        lines.push(`  ${key}:`);
        for (const e of errs) lines.push(`    [${e.code}] ${e.message}`);
      }
      throw new Error(lines.join("\n"));
    }
  });
});
