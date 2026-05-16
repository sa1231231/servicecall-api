/**
 * Seed / refresh the vertical draft templates in the `agent_drafts` collection.
 *
 * Clones the live "HVAC Default" draft into three new vertical templates —
 * Plumbing, Concrete & Masonry, and Restoration (Water/Fire) — and finishes the
 * existing "Handyman Default" draft by adding the fine-tune examples it was
 * missing (problem_description + per-path transition examples).
 *
 * Drafts are plain configs (the `is_template` flag was removed) — every draft
 * is usable by POST /agents/from-draft. `exportConfig` is the canonical shape
 * that builds agents; `formData` is the form-editor shape. Both are patched in
 * lockstep. Idempotent: upserts by draft `name`, so re-running updates in place.
 *
 * Run (dry run first to review, then for real):
 *   MONGODB_URL='<public proxy URL>' npx tsx tools/seed-vertical-templates.ts --dry-run
 *   MONGODB_URL='<public proxy URL>' npx tsx tools/seed-vertical-templates.ts
 */
import { MongoClient } from "mongodb";

const DRY_RUN = process.argv.includes("--dry-run");
const MONGO_CONN = process.env.MONGODB_URL;
if (!MONGO_CONN) {
  console.error(
    "MONGODB_URL env var is required (use the Railway public Mongo proxy URL).",
  );
  process.exit(1);
}

// ── Types ────────────────────────────────────────────────────────────────────
type Turn = { role: "user" | "agent"; content: string };
type FinetuneExample = { type: "positive"; transcript: Turn[] };
type ProblemSpec = { question: string; userReply: string; ack: string };

interface PathSpec {
  /** Must match a path name on the HVAC Default draft. */
  name: "service_call" | "emergency_call" | "existing_customer";
  condition: string;
  /** User utterances that route to this path. Empty for existing_customer. */
  transitionExamples: string[];
}

interface VerticalSpec {
  name: string;
  businessName: string;
  slug: string;
  faq: string;
  /** One problem_description fine-tune example, applied to every path. */
  problem: ProblemSpec;
  /** Which HVAC paths to keep, with vertical-specific conditions. */
  paths: PathSpec[];
}

// ── Builders ─────────────────────────────────────────────────────────────────
function problemFinetune(p: ProblemSpec): FinetuneExample {
  return {
    type: "positive",
    transcript: [
      { role: "agent", content: p.question },
      { role: "user", content: p.userReply },
      { role: "agent", content: p.ack },
    ],
  };
}

function transitionFinetunes(utterances: string[]): FinetuneExample[] {
  return utterances.map((u) => ({
    type: "positive",
    transcript: [
      { role: "user", content: u },
      { role: "agent", content: "" },
    ] as Turn[],
  }));
}

/** Clone the HVAC Default draft and apply a vertical's overrides. */
function buildClonedDraft(hvac: any, spec: VerticalSpec) {
  const formData = structuredClone(hvac.formData);
  const exportConfig = structuredClone(hvac.exportConfig);
  const keep = new Set(spec.paths.map((p) => p.name));
  const ft = problemFinetune(spec.problem);

  formData.businessName = spec.businessName;
  formData.faqKnowledgeBase = spec.faq;
  exportConfig.business.businessName = spec.businessName;
  exportConfig.business.faqKnowledgeBase = spec.faq;
  exportConfig.client.slug = spec.slug;
  exportConfig.client.name = spec.businessName;
  exportConfig.exportedAt = new Date().toISOString();

  // formData.routingPaths — filter to kept paths; patch condition + problem ft.
  formData.routingPaths = formData.routingPaths
    .filter((rp: any) => keep.has(rp.name))
    .map((rp: any) => {
      const ps = spec.paths.find((p) => p.name === rp.name)!;
      rp.condition = ps.condition;
      rp.chain = rp.chain.map((dp: any) =>
        dp && typeof dp === "object" && dp._ref === "problem_description"
          ? { _ref: "problem_description", finetuneExamples: [ft] }
          : dp,
      );
      return rp;
    });

  // exportConfig.paths — filter; patch transitionCondition + problem ft +
  // per-path transition fine-tune examples.
  exportConfig.paths = exportConfig.paths
    .filter((p: any) => keep.has(p.name))
    .map((p: any) => {
      const ps = spec.paths.find((x) => x.name === p.name)!;
      p.transitionCondition = ps.condition;
      p.dataPoints = p.dataPoints.map((dp: any) =>
        dp && typeof dp === "object" && dp.variableName === "problem_description"
          ? { variableName: "problem_description", finetuneExamples: [ft] }
          : dp,
      );
      if (ps.transitionExamples.length > 0) {
        p.transitionFinetuneExamples = transitionFinetunes(ps.transitionExamples);
      } else {
        delete p.transitionFinetuneExamples;
      }
      return p;
    });

  // Drop pathClosePrompts entries for paths that were removed.
  const pcp = exportConfig.business.pathClosePrompts ?? {};
  exportConfig.business.pathClosePrompts = Object.fromEntries(
    Object.entries(pcp).filter(([k]) => keep.has(k)),
  );

  return { name: spec.name, formData, exportConfig };
}

// ── Handyman: finish the existing draft in place ─────────────────────────────
const HANDYMAN_PROBLEM: ProblemSpec = {
  question: "What do you need help with?",
  userReply:
    "I've got a few things around the house — a leaky faucet and a door that won't latch.",
  ack: "Got it, thanks for the rundown.",
};

const HANDYMAN_TRANSITIONS: Record<string, string[]> = {
  service_call: [
    "I've got a list of small repairs around the house.",
    "Can someone come hang some shelves and fix a door?",
    "I need a handyman for some general maintenance work.",
  ],
  emergency_call: [
    "Something's actively leaking and getting worse — I need help now.",
    "I need someone out today, this really can't wait.",
  ],
  existing_customer: [],
};

/** Add the fine-tune examples the Handyman Default draft was missing, without
 *  touching its existing FAQ, conditions, or dispatch config. */
function finishHandyman(hand: any) {
  const formData = structuredClone(hand.formData);
  const exportConfig = structuredClone(hand.exportConfig);
  const ft = problemFinetune(HANDYMAN_PROBLEM);

  const patchProblem = (dp: any, key: "_ref" | "variableName") =>
    dp === "problem_description" ||
    (dp && typeof dp === "object" && dp[key] === "problem_description")
      ? { [key]: "problem_description", finetuneExamples: [ft] }
      : dp;

  formData.routingPaths = formData.routingPaths.map((rp: any) => {
    rp.chain = rp.chain.map((dp: any) => patchProblem(dp, "_ref"));
    return rp;
  });
  exportConfig.paths = exportConfig.paths.map((p: any) => {
    p.dataPoints = p.dataPoints.map((dp: any) => patchProblem(dp, "variableName"));
    const tx = HANDYMAN_TRANSITIONS[p.name] ?? [];
    if (tx.length > 0) p.transitionFinetuneExamples = transitionFinetunes(tx);
    return p;
  });
  exportConfig.exportedAt = new Date().toISOString();
  return { name: hand.name, formData, exportConfig };
}

// ── Vertical specs ───────────────────────────────────────────────────────────
const VERTICALS: VerticalSpec[] = [
  {
    name: "Plumbing Default",
    businessName: "Sample Plumbing Co",
    slug: "sample-plumbing",
    faq: [
      "## Company Info",
      "[Business name] is a residential and light-commercial plumbing company.",
      "",
      "## Service Area",
      "[Replace with the cities / region served.]",
      "",
      "## Hours",
      "[Replace with business hours. Note whether 24/7 emergency service is offered.]",
      "",
      "## Services Offered",
      "- Leak detection and repair",
      "- Drain and sewer cleaning",
      "- Water heater repair, replacement, and installation",
      "- Fixture installation and repair (faucets, toilets, sinks, garbage disposals)",
      "- Repiping and pipe repair",
      "- Emergency plumbing",
      "",
      "## Pricing & Payment",
      "Do not quote prices on the phone. A plumber will provide pricing during the visit or consultation.",
      "",
      "## Emergency Service",
      "[Replace with the after-hours / emergency policy.]",
    ].join("\n"),
    problem: {
      question: "What's going on with your plumbing?",
      userReply: "My water heater stopped working and there's no hot water.",
      ack: "Got it, thanks for letting me know.",
    },
    paths: [
      {
        name: "service_call",
        condition:
          "The caller wants non-emergency plumbing service, a repair, an installation, or a quote — leaks, clogs, fixtures, water heaters, and similar work that is not an active emergency.",
        transitionExamples: [
          "My water heater isn't working, can someone come out?",
          "I've got a slow drain I'd like looked at.",
          "I'd like a quote on replacing a faucet.",
        ],
      },
      {
        name: "emergency_call",
        condition:
          "The caller is experiencing an active plumbing emergency that needs response now — a burst pipe, major leak, flooding, sewage backup, or no water in the home.",
        transitionExamples: [
          "A pipe burst and water is everywhere — I need someone now.",
          "My basement is flooding, can you send someone right away?",
        ],
      },
      {
        name: "existing_customer",
        condition:
          "The caller is an existing customer referencing prior work done with a question or followup.",
        transitionExamples: [],
      },
    ],
  },
  {
    name: "Concrete & Masonry Default",
    businessName: "Sample Concrete & Masonry",
    slug: "sample-concrete-masonry",
    faq: [
      "## Company Info",
      "[Business name] is a concrete and masonry contractor.",
      "",
      "## Service Area",
      "[Replace with the cities / region served.]",
      "",
      "## Hours",
      "[Replace with business hours.]",
      "",
      "## Services Offered",
      "- Concrete driveways, patios, walkways, and slabs",
      "- Foundations and footings",
      "- Retaining walls and steps",
      "- Brick, block, and stone masonry",
      "- Concrete and masonry repair and resurfacing",
      "",
      "## Pricing & Payment",
      "Do not quote prices on the phone. A representative will provide pricing after reviewing the project, usually with an on-site estimate.",
    ].join("\n"),
    problem: {
      question: "Tell me about the concrete or masonry project you have in mind.",
      userReply: "I need a new driveway poured, the old one is all cracked.",
      ack: "Got it, thanks — that helps.",
    },
    // Quote-driven trade: no emergency path (mirrors the Dumpster draft's shape).
    paths: [
      {
        name: "service_call",
        condition:
          "The caller wants concrete or masonry work — a new pour, a driveway, patio, walkway, foundation, retaining wall, steps, or repair of existing concrete or masonry. Treated as a quote or estimate request.",
        transitionExamples: [
          "I'd like a quote on a new driveway.",
          "I need some cracked concrete steps repaired.",
          "Can someone come give me an estimate on a patio?",
        ],
      },
      {
        name: "existing_customer",
        condition:
          "The caller is an existing customer referencing prior concrete or masonry work with a question or followup.",
        transitionExamples: [],
      },
    ],
  },
  {
    name: "Restoration (Water/Fire) Default",
    businessName: "Sample Restoration Co",
    slug: "sample-restoration",
    faq: [
      "## Company Info",
      "[Business name] is a water, fire, and storm damage restoration company.",
      "",
      "## Service Area",
      "[Replace with the cities / region served.]",
      "",
      "## Hours",
      "[Replace with business hours. Most restoration companies offer 24/7 emergency response.]",
      "",
      "## Services Offered",
      "- Water damage cleanup and structural drying",
      "- Flood and storm damage restoration",
      "- Fire and smoke damage restoration",
      "- Mold inspection and remediation",
      "- Sewage cleanup",
      "- Reconstruction and repairs",
      "",
      "## Insurance",
      "We work with most homeowners' insurance carriers and can help document the loss for a claim.",
      "",
      "## Pricing & Payment",
      "Do not quote prices on the phone. A project manager will assess the damage on site and provide an estimate.",
      "",
      "## Emergency Service",
      "[Replace with the emergency response policy — most restoration work is urgent.]",
    ].join("\n"),
    problem: {
      question: "Tell me what happened and what's been damaged.",
      userReply: "We had a pipe burst overnight and the whole floor is soaked.",
      ack: "Okay, thank you — I've got that.",
    },
    paths: [
      {
        name: "service_call",
        condition:
          "The caller wants a non-urgent inspection, assessment, or estimate for water, fire, smoke, or mold damage that is not an active emergency.",
        transitionExamples: [
          "I'd like someone to assess some old water damage.",
          "Can I get an estimate on mold remediation?",
        ],
      },
      {
        name: "emergency_call",
        condition:
          "The caller has active or recent water damage, flooding, fire or smoke damage, or mold that needs an immediate response.",
        transitionExamples: [
          "Our house flooded last night and we need help right away.",
          "We just had a fire and need someone out as soon as possible.",
          "There's water coming through the ceiling — can you send someone now?",
        ],
      },
      {
        name: "existing_customer",
        condition:
          "The caller is an existing customer referencing a prior restoration job with a question or followup.",
        transitionExamples: [],
      },
    ],
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const client = new MongoClient(MONGO_CONN!);
  await client.connect();
  const col = client.db().collection("agent_drafts");

  const hvac = await col
    .find({ name: "HVAC Default" })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();
  if (!hvac) throw new Error('"HVAC Default" draft not found — cannot clone.');

  const handyman = await col
    .find({ name: "Handyman Default" })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();
  if (!handyman) throw new Error('"Handyman Default" draft not found.');

  const built = [
    ...VERTICALS.map((spec) => buildClonedDraft(hvac, spec)),
    finishHandyman(handyman),
  ];

  console.log(DRY_RUN ? "DRY RUN — no writes\n" : "Seeding agent_drafts\n");
  for (const draft of built) {
    const paths = draft.exportConfig.paths
      .map((p: any) => p.name)
      .join(", ");
    console.log(`=== ${draft.name} ===`);
    console.log(`  paths: ${paths}`);
    if (DRY_RUN) {
      console.log("  [dry-run] not written\n");
      continue;
    }
    await col.updateOne(
      { name: draft.name },
      {
        $set: {
          name: draft.name,
          formData: draft.formData,
          exportConfig: draft.exportConfig,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    console.log("  upserted\n");
  }

  await client.close();
  console.log(DRY_RUN ? "Dry run complete." : "Done.");
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
