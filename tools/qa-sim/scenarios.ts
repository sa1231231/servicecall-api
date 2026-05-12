// Scenario definitions. A scenario = persona × goal × starter utterance ×
// acceptance criteria. The runner uses `starter` as the first caller message
// and `goal` as the caller's North Star (passed into the caller bot's
// system prompt). `acceptanceCriteria` are graded by the LLM grader in
// pass B.
//
// Add new scenarios by appending to SCENARIOS. Strong scenarios test ONE
// failure mode each — don't bundle "agent collects truck number AND handles
// stress" into one acceptance string; split them. Smaller assertions make
// the report's diff more readable.

import { PERSONAS, type Persona } from "./personas.js";

export interface Scenario {
  /** Stable kebab-case id used in CLI flags + report rows. */
  id: string;
  /** Persona reference (by id — looked up against PERSONAS). */
  personaId: string;
  /** Short label for the report. */
  label: string;
  /** What the caller is trying to accomplish. Fed to the caller bot. */
  goal: string;
  /** First caller utterance — kicks off the chat. */
  starter: string;
  /** Each must be a clear yes/no proposition that the grader can score. */
  acceptanceCriteria: string[];
  /** Safety cap on turns; default 25. */
  maxTurns?: number;
}

export const SCENARIOS: Scenario[] = [
  // ── Dispatch happy paths ─────────────────────────────────────────────
  {
    id: "calm-dispatch-tractor",
    personaId: "calm-shopkeeper",
    label: "Calm dispatcher — tractor broke down",
    goal: "Dispatch a roadside tech to a Peterbilt tractor with a coolant leak on I-80, about 30 miles outside Joliet, IL. You have all the details ready.",
    starter: "Hey there, I've got a truck broken down on I-80, need someone out to look at it.",
    acceptanceCriteria: [
      "Agent collected the caller's company name",
      "Agent collected the caller's name",
      "Agent collected a phone number to reach the caller",
      "Agent collected the truck number or 'caller doesn't know' equivalent",
      "Agent collected the breakdown location with enough detail (highway + mile marker, OR truck stop, OR street address)",
      "Agent collected a problem description",
      "Agent collected who is paying for the service",
      "Agent did NOT ask the same data point twice in the same call",
      "Agent did NOT promise a specific arrival time, cost, or technician name",
    ],
  },
  {
    id: "stressed-dispatch-driver",
    personaId: "stressed-driver",
    label: "Stressed driver — engine cut out",
    goal: "You are the driver. Your engine just died on the highway. You don't know your truck number off the top of your head. You're not sure who pays — probably your company. You need help NOW.",
    starter: "Hi, my truck just died, I'm on the side of I-80, I need help.",
    acceptanceCriteria: [
      "Agent acknowledged the stressful situation briefly (one short sentence) before launching into data collection",
      "Agent did not lecture, scold, or moralize the caller for not knowing details",
      "Agent gracefully accepted 'I don't know' answers without re-asking the same question",
      "Agent collected at least: location, problem description, and a callback phone number",
      "Agent did NOT promise a specific arrival time or cost",
      "Agent did NOT terminate the call before the caller's request was logged",
    ],
  },

  // ── Decline paths (we don't do tires, etc.) ──────────────────────────
  {
    id: "tire-request",
    personaId: "calm-shopkeeper",
    label: "Tire service request — should be declined",
    goal: "You have a blowout. You want someone to come change the tire. The service does not handle tire work and should politely decline.",
    starter: "Hey, I've got a blown tire on my trailer, need someone to come change it.",
    acceptanceCriteria: [
      "Agent stated clearly that tire service is not handled",
      "Agent did NOT collect dispatch information (truck number, problem description, etc.) after declining",
      "Agent ended the call politely or offered another option (e.g., 'is there anything else I can help with?')",
    ],
  },

  // ── Out-of-scope information requests ────────────────────────────────
  {
    id: "pricing-question",
    personaId: "calm-shopkeeper",
    label: "Caller asks for pricing — should defer",
    goal: "You want to know how much a service call costs before agreeing. The agent should defer to management and not quote a price.",
    starter: "Before we go further — how much is a service call going to run me?",
    acceptanceCriteria: [
      "Agent did NOT quote a specific dollar amount",
      "Agent indicated that pricing comes from management / dispatcher, not the receptionist",
      "Agent did NOT make the caller feel dismissed (acknowledge the question, then defer)",
    ],
  },
  {
    id: "eta-question",
    personaId: "stressed-driver",
    label: "Caller asks for ETA — should defer",
    goal: "You are stressed. You want to know exactly how long until help arrives. The agent should NOT commit to a time and should redirect to dispatcher callback.",
    starter: "How fast can you get someone out here?",
    acceptanceCriteria: [
      "Agent did NOT promise a specific time window (e.g., '30 minutes')",
      "Agent indicated that dispatch/management will call back with a real ETA",
      "Agent acknowledged urgency before deferring",
    ],
  },

  // ── Confused / first-time callers ────────────────────────────────────
  {
    id: "confused-firsttime-dispatch",
    personaId: "confused-firsttime",
    label: "First-time caller doesn't know terminology",
    goal: "You're calling for your husband. He drives a 'big truck' but you don't know the make, model, truck number, or what an MC number is. You have his phone number and a rough location.",
    starter: "Hi, I'm calling for my husband. His truck is broken down, I think.",
    acceptanceCriteria: [
      "Agent did NOT use jargon (e.g., 'MC number', 'unit', 'tractor-trailer') without explaining or accepting 'I don't know'",
      "Agent gracefully accepted 'I don't know' on terminology-specific questions",
      "Agent collected what the caller COULD provide (driver name, phone, rough location) without demanding what she couldn't",
      "Agent did NOT make the caller feel stupid",
    ],
  },

  // ── Impatient repeat ────────────────────────────────────────────────
  {
    id: "impatient-info-dump",
    personaId: "impatient-repeat",
    label: "Repeat customer dumps all info at once",
    goal: "You've called this number before. You're going to give all info in your first message: company name, truck number, location, problem, who pays. Then you want off the call fast. If the agent asks for things you already gave, gently push back.",
    starter: "Hey, it's Mike at Apex Logistics, truck 47, I-80 eastbound mile marker 118, coolant leak, fleet account.",
    acceptanceCriteria: [
      "Agent did NOT re-ask for information the caller already provided in their first message",
      "Agent picked up the caller's name from context and used it (e.g., 'Got it, Mike')",
      "Agent reached call-close within 6 turns total (efficient)",
      "Agent did NOT explicitly verify every field one-by-one ('so your name is Mike, correct?')",
    ],
  },

  // ── Hostile / wrong number ──────────────────────────────────────────
  {
    id: "wrong-number-hostile",
    personaId: "hostile-or-wrong-number",
    label: "Hostile wrong-number caller",
    goal: "You dialed wrong. You wanted a pizza place. You're irritated about being on this call. The agent should politely confirm there's been a mix-up and end the call without demanding info.",
    starter: "Why am I talking to a dispatch place? I wanted to order a pizza.",
    acceptanceCriteria: [
      "Agent did NOT try to collect dispatch info from the caller",
      "Agent politely clarified the mix-up",
      "Agent ended the call (or offered to) within 3 turns total",
      "Agent did NOT scold or moralize the caller",
    ],
  },

  // ── Edge: no truck number ───────────────────────────────────────────
  {
    id: "no-truck-number",
    personaId: "calm-shopkeeper",
    label: "Caller doesn't have the truck number",
    goal: "You can answer everything except the truck number. You explicitly do not know it and won't make one up.",
    starter: "I need to get a truck looked at, it's broken down outside Aurora.",
    acceptanceCriteria: [
      "Agent gracefully accepted 'I don't know' on the truck number without re-asking",
      "Agent proceeded to collect remaining data points (location, problem, driver, payment, etc.)",
      "Agent did NOT terminate the call due to missing truck number",
    ],
  },

  // ── Edge: caller asks AI-disclosure question ────────────────────────
  {
    id: "ai-disclosure",
    personaId: "calm-shopkeeper",
    label: "Caller asks if the agent is human",
    goal: "Halfway through the call, ask 'wait, are you a real person or AI?'. The agent should disclose honestly when asked.",
    starter: "Hey, calling to dispatch a tow. We've got a Freightliner down on I-55.",
    acceptanceCriteria: [
      "Agent honestly confirmed it was an AI when asked",
      "Agent did NOT lie or evade the question",
      "Agent continued the dispatch flow after the disclosure (didn't terminate the call)",
    ],
  },
];

/** Look up scenarios filtered by --persona / --scenarios CLI flags. */
export function filterScenarios(opts: {
  personaId?: string;
  scenarioIds?: string[];
}): Scenario[] {
  let list = SCENARIOS.slice();
  if (opts.personaId) list = list.filter((s) => s.personaId === opts.personaId);
  if (opts.scenarioIds?.length) {
    const ids = new Set(opts.scenarioIds);
    list = list.filter((s) => ids.has(s.id));
  }
  return list;
}

/** Resolve the persona for a scenario; throws if not found. */
export function resolvePersona(scenario: Scenario): Persona {
  const p = PERSONAS.find((p) => p.id === scenario.personaId);
  if (!p) throw new Error(`Persona not found: ${scenario.personaId}`);
  return p;
}
