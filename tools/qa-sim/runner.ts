// Scenario runner: clones a voice agent into a chat agent, drives the
// caller bot turn-by-turn, captures the transcript, then deletes the chat
// clone. One file per completed scenario lands in
// `tools/qa-sim/runs/<timestamp>/<scenario.id>.json`.
//
// The clone-and-delete pattern keeps the production voice agent untouched
// (no test traffic shows up in its call log) and Retell-side counts of
// chat-agent rows clean.

import { promises as fs } from "fs";
import path from "path";
import {
  createChatCloneFromVoiceAgent,
  deleteChatAgent,
  startChat,
  sendUserMessage,
  endChat,
  type ChatResult,
} from "../../src/lib/retell-chat-driver.js";
import { generateCallerReply, type TranscriptTurn } from "./caller-bot.js";
import type { Scenario } from "./scenarios.js";
import { resolvePersona } from "./scenarios.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScenarioRun {
  scenarioId: string;
  scenarioLabel: string;
  personaId: string;
  agentSlug: string;
  voiceAgentId: string;
  chatAgentId: string;
  chatId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  turnCount: number;
  /** Reason the scenario ended: caller hung up, max turns hit, agent ended
   *  the chat, or an error. */
  endedBy: "caller_hangup" | "agent_ended" | "max_turns" | "error";
  errorMessage?: string;
  /** Full transcript as alternating speaker/text turns. */
  transcript: TranscriptTurn[];
  /** Node names visited in order (best-effort; from Retell node_transitions). */
  visitedNodes: string[];
  /** Variables collected by the agent at scenario end. */
  collectedVars: Record<string, unknown>;
}

export interface RunnerOptions {
  /** Slug to label the run; doesn't affect Retell. */
  agentSlug: string;
  /** Voice agent id (agent_…) to clone into a chat agent for this run. */
  voiceAgentId: string;
  /** Where to write per-scenario JSON. */
  runDir: string;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Run a single scenario end-to-end and persist the result. */
export async function runScenario(
  scenario: Scenario,
  opts: RunnerOptions,
): Promise<ScenarioRun> {
  const persona = resolvePersona(scenario);
  const maxTurns = scenario.maxTurns ?? 25;

  const startedAt = new Date();
  const cloneName = `qa-sim-${scenario.id}-${Date.now()}`;
  let chatAgentId = "";
  let chatId = "";
  const transcript: TranscriptTurn[] = [];
  const visitedNodes: string[] = [];
  let endedBy: ScenarioRun["endedBy"] = "max_turns";
  let errorMessage: string | undefined;

  try {
    // 1. Clone voice agent → chat agent (so we don't touch the prod voice agent).
    chatAgentId = await createChatCloneFromVoiceAgent(opts.voiceAgentId, cloneName);

    // 2. Open the chat. Capture the agent's opening greeting(s).
    const { chatId: id, openingMessages } = await startChat(chatAgentId);
    chatId = id;
    for (const msg of openingMessages) {
      transcript.push({ speaker: "agent", text: msg });
    }

    // 3. First caller utterance = scenario.starter (deterministic kickoff).
    transcript.push({ speaker: "caller", text: scenario.starter });
    let agentTurn = await sendUserMessage(chatId, scenario.starter);
    for (const m of agentTurn.agentMessages) {
      transcript.push({ speaker: "agent", text: m });
    }
    for (const t of agentTurn.nodeTransitions) {
      if (t.to) visitedNodes.push(t.to);
    }
    if (agentTurn.ended) {
      endedBy = "agent_ended";
    }

    // 4. Drive the conversation with caller-bot until end-condition.
    let turn = 1;
    while (!agentTurn.ended && turn < maxTurns) {
      const reply = await generateCallerReply({ persona, scenario, history: transcript });
      if (reply.hang_up || !reply.say) {
        endedBy = "caller_hangup";
        if (reply.say) transcript.push({ speaker: "caller", text: reply.say });
        break;
      }
      transcript.push({ speaker: "caller", text: reply.say });
      agentTurn = await sendUserMessage(chatId, reply.say);
      for (const m of agentTurn.agentMessages) {
        transcript.push({ speaker: "agent", text: m });
      }
      for (const t of agentTurn.nodeTransitions) {
        if (t.to) visitedNodes.push(t.to);
      }
      if (agentTurn.ended) {
        endedBy = "agent_ended";
        break;
      }
      turn++;
    }
  } catch (err) {
    endedBy = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  // 5. Finalize: get the canonical Retell transcript + collected vars.
  let final: ChatResult | undefined;
  if (chatId) {
    try {
      final = await endChat(chatId);
    } catch (err) {
      // Already-ended chat → ignore; we still have our local transcript.
    }
  }

  // 6. Always clean up the cloned chat agent — it cost nothing per call but
  //    leaves clutter in Retell otherwise.
  if (chatAgentId) {
    try { await deleteChatAgent(chatAgentId); } catch { /* best-effort */ }
  }

  const endedAt = new Date();
  const run: ScenarioRun = {
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    personaId: scenario.personaId,
    agentSlug: opts.agentSlug,
    voiceAgentId: opts.voiceAgentId,
    chatAgentId,
    chatId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    turnCount: transcript.filter((t) => t.speaker === "caller").length,
    endedBy,
    errorMessage,
    transcript,
    visitedNodes: final?.visitedNodes ?? visitedNodes,
    collectedVars: final?.collectedVariables ?? {},
  };

  // 7. Persist.
  await fs.mkdir(opts.runDir, { recursive: true });
  const filePath = path.join(opts.runDir, `${scenario.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(run, null, 2), "utf8");

  return run;
}

/** Run multiple scenarios in series (parallelism deferred — preserves
 *  log-readability while we iterate). */
export async function runAll(
  scenarios: Scenario[],
  opts: RunnerOptions,
  onProgress?: (s: Scenario, result: ScenarioRun) => void,
): Promise<ScenarioRun[]> {
  const results: ScenarioRun[] = [];
  for (const sc of scenarios) {
    const r = await runScenario(sc, opts);
    results.push(r);
    onProgress?.(sc, r);
  }
  return results;
}
