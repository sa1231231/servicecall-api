import "dotenv/config";
import Retell from "retell-sdk";

const apiKey = process.env.RETELL_API_KEY;
if (!apiKey) {
  console.error("RETELL_API_KEY not set");
  process.exit(1);
}

const retell = new Retell({ apiKey });

const TARGET_STT_MODE = "custom" as const;
const TARGET_PROVIDER = "soniox" as const;
const TARGET_ENDPOINTING_MS = 700;

const apply = process.argv.includes("--apply");

async function main() {
  const allVersions = await retell.agent.list();
  // Retell returns one row per agent version. Keep only the highest version
  // per agent_id — that's the canonical "current" config.
  const byId = new Map<string, (typeof allVersions)[number]>();
  for (const v of allVersions) {
    const existing = byId.get(v.agent_id);
    const ver = (v as Record<string, unknown>).version as number | undefined;
    const existingVer = existing
      ? ((existing as Record<string, unknown>).version as number | undefined)
      : undefined;
    if (!existing || (ver ?? 0) > (existingVer ?? 0)) {
      byId.set(v.agent_id, v);
    }
  }
  const agents = Array.from(byId.values());
  console.log(
    `Found ${allVersions.length} agent-version rows, ${agents.length} unique agents\n`,
  );

  const needsUpdate: typeof agents = [];
  const alreadyOk: typeof agents = [];

  for (const agent of agents) {
    const a = agent as Record<string, unknown>;
    const sttMode = a.stt_mode as string | undefined;
    const customSttConfig = a.custom_stt_config as
      | { provider?: string; endpointing_ms?: number }
      | undefined;

    const isOk =
      sttMode === TARGET_STT_MODE &&
      customSttConfig?.provider === TARGET_PROVIDER &&
      customSttConfig?.endpointing_ms === TARGET_ENDPOINTING_MS;

    if (isOk) {
      alreadyOk.push(agent);
    } else {
      needsUpdate.push(agent);
    }

    const provider = customSttConfig?.provider ?? "(none)";
    const endpointing = customSttConfig?.endpointing_ms ?? "(none)";
    console.log(
      `${isOk ? "OK  " : "DIFF"} ${agent.agent_id}  ${agent.agent_name ?? "(no name)"}  stt_mode=${sttMode ?? "(unset)"}  provider=${provider}  endpointing_ms=${endpointing}`,
    );
  }

  console.log(
    `\nSummary: ${alreadyOk.length} already match, ${needsUpdate.length} need update`,
  );

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to update.");
    return;
  }

  if (needsUpdate.length === 0) {
    console.log("Nothing to update.");
    return;
  }

  console.log(`\nApplying updates to ${needsUpdate.length} agents...\n`);
  let success = 0;
  const failures: { agent_id: string; error: string }[] = [];

  for (const agent of needsUpdate) {
    try {
      await retell.agent.update(agent.agent_id, {
        stt_mode: TARGET_STT_MODE,
        custom_stt_config: {
          provider: TARGET_PROVIDER,
          endpointing_ms: TARGET_ENDPOINTING_MS,
        },
      } as never);
      console.log(`  ✓ ${agent.agent_id}  ${agent.agent_name ?? ""}`);
      success++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${agent.agent_id}  ${agent.agent_name ?? ""}  ${msg}`);
      failures.push({ agent_id: agent.agent_id, error: msg });
    }
  }

  console.log(`\nDone. ${success} updated, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ${f.agent_id}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
