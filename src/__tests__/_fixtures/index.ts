import type { AgentFixture } from "./types.js";

export type { AgentFixture, PathScenario } from "./types.js";

// No active fixtures right now. Demo Meter and Moss's H&C — the prior
// canonical fixtures — were both retired when the test agent was swapped
// to Demo HVAC. Authoring HVAC-shaped scenarios (service_call,
// emergency_call, existing_customer paths) is a follow-up.
//
// `conversation-paths.test.ts` iterates this array; an empty list makes
// that suite a no-op until fixtures are added.
export const AGENT_FIXTURES: AgentFixture[] = [];
