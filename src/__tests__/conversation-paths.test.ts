import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startChat,
  sendUserMessage,
  endChat,
  createChatCloneFromVoiceAgent,
  deleteChatAgent,
} from "../lib/retell-chat-driver.js";
import { AGENT_FIXTURES, type AgentFixture, type PathScenario } from "./_fixtures/index.js";

const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const ROOT_PASSWORD = process.env.ROOT_PASSWORD;
const RETELL_API_KEY = process.env.RETELL_API_KEY;

const hasConfig =
  !!BASE_URL && BASE_URL.startsWith("http") && !!API_KEY && !!RETELL_API_KEY && !!ROOT_PASSWORD;

const TERMINAL_NODE_RE = /^(Close|Closing\s|Pre-Transfer|Transfer Call)/i;

function url(path: string): string {
  return `${BASE_URL}${path}`;
}

function authHeaders(extras: Record<string, string> = {}): Record<string, string> {
  return {
    "x-api-key": API_KEY!,
    Authorization: "Basic " + Buffer.from(`sam_admin:${ROOT_PASSWORD}`).toString("base64"),
    "Content-Type": "application/json",
    ...extras,
  };
}

interface PathInfo {
  pathName: string;
  /** Map of "Collect X" node name → variable name extracted there. */
  collectNodeNameToVar: Record<string, string>;
  /** Variable names in the order they're collected on this path. */
  dataPointOrder: string[];
}

interface ScenarioRun {
  callId: string;
  collected: Record<string, unknown>;
  visitedNodes: string[];
  transcript: string;
  turnLog: Array<{ user: string; agent: string[]; transitions: Array<{ from?: string; to?: string }> }>;
}

async function fetchPathInfoMap(slug: string, agentId: string): Promise<Record<string, PathInfo>> {
  const resp = await fetch(
    url(`/dashboard/api/agents/${slug}/nodes/${agentId}`),
    { headers: authHeaders() },
  );
  if (!resp.ok) throw new Error(`Failed to fetch path info for ${slug}: ${resp.status}`);
  const body = await resp.json();
  const nodeIdToName: Record<string, string> = {};
  for (const n of body.nodes ?? []) nodeIdToName[n.id] = n.name;
  const result: Record<string, PathInfo> = {};
  for (const p of body.paths ?? []) {
    const collectNodeNameToVar: Record<string, string> = {};
    const dataPointOrder: string[] = [];
    for (const dp of p.dataPoints ?? []) {
      const nodeName = nodeIdToName[dp.collectNodeId];
      if (nodeName) collectNodeNameToVar[nodeName] = dp.variableName;
      dataPointOrder.push(dp.variableName);
    }
    result[p.name] = { pathName: p.name, collectNodeNameToVar, dataPointOrder };
  }
  return result;
}

async function runScenario(
  fixture: AgentFixture,
  chatAgentId: string,
  scenario: PathScenario,
  pathInfo: PathInfo,
): Promise<ScenarioRun> {
  const { chatId, openingMessages } = await startChat(chatAgentId);
  const turnLog: ScenarioRun["turnLog"] = [
    { user: "<chat opened>", agent: openingMessages, transitions: [] },
  ];

  let currentNode: string | null = null;
  let nextReply = scenario.triggerMessage;
  const answered = new Set<string>();
  const filler = scenario.fillerReply ?? "Yes please.";
  const maxTurns = scenario.maxTurns ?? 25;

  for (let i = 0; i < maxTurns; i++) {
    const t = await sendUserMessage(chatId, nextReply);
    if (t.nodeTransitions.length > 0) {
      currentNode = t.nodeTransitions[t.nodeTransitions.length - 1].to ?? currentNode;
    }
    turnLog.push({ user: nextReply, agent: t.agentMessages, transitions: t.nodeTransitions });
    if (t.ended) break;

    // If we entered a Collect node we have a reply for, send it
    const varName = currentNode ? pathInfo.collectNodeNameToVar[currentNode] : undefined;
    if (varName && !answered.has(varName) && scenario.replies[varName] !== undefined) {
      nextReply = scenario.replies[varName];
      answered.add(varName);
      continue;
    }

    // If we've answered all data points, agent should be wrapping up — send filler to advance
    const allAnswered = pathInfo.dataPointOrder.every((v) => answered.has(v) || scenario.replies[v] === undefined);
    if (allAnswered && currentNode && TERMINAL_NODE_RE.test(currentNode)) break;

    // If we're at a Collect node we don't have a reply for, send "I don't know" so agent moves on
    if (varName && !answered.has(varName)) {
      nextReply = "I'm not sure";
      answered.add(varName);
      continue;
    }

    // Otherwise send filler (intro/transition turns, or unknown nodes)
    nextReply = filler;
  }

  const result = await endChat(chatId);

  const callId = `chat-test-${fixture.slug}-${scenario.scenarioName}-${chatId}`;
  const callEndedPayload = {
    event: "call_ended",
    call: {
      call_id: callId,
      agent_id: fixture.agentId,
      from_number: "unknown",
      to_number: "+15555550199",
      duration_ms: 30_000,
      disconnection_reason: "user_hangup",
      retell_llm_dynamic_variables: {},
      collected_dynamic_variables: result.collectedVariables,
      call_cost: { combined_cost: 0 },
    },
  };

  const resp = await fetch(url("/retell/post-hook"), {
    method: "POST",
    headers: authHeaders({ "x-test-mode": "true" }),
    body: JSON.stringify(callEndedPayload),
  });
  expect(resp.status).toBe(200);

  return {
    callId,
    collected: result.collectedVariables,
    visitedNodes: result.visitedNodes,
    transcript: result.transcript,
    turnLog,
  };
}

function matchesExpectVariables(run: ScenarioRun, scenario: PathScenario): boolean {
  for (const [key, expected] of Object.entries(scenario.expectVariables ?? {})) {
    const actual = String(run.collected[key] ?? "");
    if (expected instanceof RegExp) {
      if (!expected.test(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * Run a flaky scenario N times and return any run that passed expectVariables,
 * provided ≥ majority of the N runs passed. Each run hits live Retell.
 */
async function runScenarioMajorityPass(
  fixture: AgentFixture,
  chatAgentId: string,
  scenario: PathScenario,
  pathInfo: PathInfo,
  N = 3,
): Promise<ScenarioRun> {
  const passing: ScenarioRun[] = [];
  const failures: Array<{ run?: ScenarioRun; err?: unknown }> = [];
  for (let i = 0; i < N; i++) {
    try {
      const r = await runScenario(fixture, chatAgentId, scenario, pathInfo);
      if (matchesExpectVariables(r, scenario)) passing.push(r);
      else failures.push({ run: r });
    } catch (e) {
      failures.push({ err: e });
    }
  }
  const required = Math.ceil(N / 2);
  if (passing.length < required) {
    throw new Error(
      `majority-pass failed for ${scenario.scenarioName}: ${passing.length}/${N} passed (needed ${required})`,
    );
  }
  return passing[0];
}

async function fetchCallLog(slug: string, callId: string, attempts = 8): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    const resp = await fetch(
      url(`/dashboard/api/agents/${slug}/calls?limit=20&include_tests=1`),
      { headers: authHeaders() },
    );
    if (resp.ok) {
      const calls = await resp.json();
      const match = calls.find((c: any) => c._id === callId);
      if (match) return match;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Call log entry ${callId} not found after ${attempts} attempts`);
}

function debugDump(run: ScenarioRun, scenario: PathScenario, pathInfo: PathInfo): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`══ FAILURE DEBUG: ${scenario.pathName} / ${scenario.scenarioName} ══`);
  lines.push("");
  lines.push("── Per-turn dialog ──");
  for (const t of run.turnLog) {
    lines.push(`USER: ${t.user}`);
    for (const a of t.agent) lines.push(`  AGENT: ${a}`);
    for (const tr of t.transitions) lines.push(`  ⇒ NODE: ${tr.from ?? "?"} → ${tr.to ?? "?"}`);
  }
  lines.push("");
  lines.push("── Visited nodes ──");
  lines.push(run.visitedNodes.join(" → "));
  lines.push("");
  lines.push("── Path data point order ──");
  lines.push(pathInfo.dataPointOrder.join(" → "));
  lines.push("");
  lines.push("── Collected variables ──");
  for (const [k, v] of Object.entries(run.collected)) {
    lines.push(`  ${k} = ${JSON.stringify(v)}`);
  }
  lines.push("");
  lines.push("── Expected ──");
  for (const [k, v] of Object.entries(scenario.expectVariables ?? {})) {
    lines.push(`  ${k} = ${v instanceof RegExp ? v.toString() : JSON.stringify(v)}`);
  }
  lines.push("══════════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

describe.skipIf(!hasConfig)(
  "Conversation routing paths (live Retell chat)",
  { timeout: 240_000 },
  () => {
    for (const fixture of AGENT_FIXTURES) {
      describe(`agent: ${fixture.slug}`, () => {
        let chatAgentId: string;
        let pathInfoMap: Record<string, PathInfo>;

        beforeAll(async () => {
          pathInfoMap = await fetchPathInfoMap(fixture.slug, fixture.agentId);
          chatAgentId = await createChatCloneFromVoiceAgent(
            fixture.agentId,
            `chat-clone-test-${fixture.slug}-${Date.now()}`,
          );
        });

        afterAll(async () => {
          if (chatAgentId) {
            try {
              await deleteChatAgent(chatAgentId);
            } catch (e) {
              console.warn(`Failed to delete chat clone ${chatAgentId}:`, e);
            }
          }
        });

        for (const scenario of fixture.scenarios) {
          describe(`${scenario.pathName} / ${scenario.scenarioName}`, () => {
            let run: ScenarioRun;
            let callLog: any;
            let dumped = false;

            const dumpOnce = () => {
              if (!dumped && run) {
                console.error(debugDump(run, scenario, pathInfoMap[scenario.pathName]));
                dumped = true;
              }
            };

            it(`drives chat (${scenario.description})`, async () => {
              const pathInfo = pathInfoMap[scenario.pathName];
              if (!pathInfo) throw new Error(`Path ${scenario.pathName} not found in deployed flow for ${fixture.slug}`);
              run = scenario.flaky
                ? await runScenarioMajorityPass(fixture, chatAgentId, scenario, pathInfo)
                : await runScenario(fixture, chatAgentId, scenario, pathInfo);
              try {
                callLog = await fetchCallLog(fixture.slug, run.callId);
              } catch (e) {
                dumpOnce();
                throw e;
              }
            });

            it("extracts expected variables", () => {
              try {
                for (const [key, expected] of Object.entries(scenario.expectVariables ?? {})) {
                  const actual = String(run.collected[key] ?? "");
                  if (expected instanceof RegExp) {
                    expect(actual, `var ${key}=${actual}`).toMatch(expected);
                  } else {
                    expect(actual, `var ${key}`).toBe(expected);
                  }
                }
              } catch (e) {
                dumpOnce();
                throw e;
              }
            });

            it("call log records the routing decision", () => {
              try {
                expect(callLog.agent_id).toBe(fixture.agentId);
                expect(callLog.outcome).toBe("test_call");
                expect(callLog.test_mode).toBe(true);
                if (scenario.expectMessageTypeKey) {
                  expect(callLog.message_type_key).toBe(scenario.expectMessageTypeKey);
                }
              } catch (e) {
                dumpOnce();
                throw e;
              }
            });
          });
        }

        it("every deployed path has at least one fixture scenario", async () => {
          const deployedPaths = new Set<string>(Object.keys(pathInfoMap));
          const coveredPaths = new Set(fixture.scenarios.map((s) => s.pathName));
          for (const p of deployedPaths) {
            expect(coveredPaths.has(p), `Missing fixture for path "${p}" on ${fixture.slug}`).toBe(true);
          }
        });
      });
    }
  },
);
