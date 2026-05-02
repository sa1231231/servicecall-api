import type { AgentFixture } from "./types.js";
import { DEMO_METER_FIXTURE } from "./demo-meter-paths.js";
import { MOSS_FIXTURE } from "./moss-paths.js";

export type { AgentFixture, PathScenario } from "./types.js";
export { DEMO_METER_FIXTURE, DEMO_METER_AGENT_ID, DEMO_METER_SLUG } from "./demo-meter-paths.js";
export { MOSS_FIXTURE, MOSS_AGENT_ID, MOSS_SLUG } from "./moss-paths.js";

export const AGENT_FIXTURES: AgentFixture[] = [DEMO_METER_FIXTURE, MOSS_FIXTURE];
