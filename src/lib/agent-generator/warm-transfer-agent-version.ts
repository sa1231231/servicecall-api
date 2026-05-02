import type Retell from "retell-sdk";
import { WARM_TRANSFER_AGENT_ID, WARM_TRANSFER_AGENT_VERSION_FALLBACK } from "./node-builders.js";

const CACHE_TTL_MS = 30_000;
let cachedVersion: number | null = null;
let cachedAt = 0;

export function _resetWarmTransferAgentVersionCache() {
  cachedVersion = null;
  cachedAt = 0;
}

export async function getWarmTransferAgentVersion(retell: Retell): Promise<number> {
  const now = Date.now();
  if (cachedVersion !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedVersion;
  }
  try {
    const agent = await retell.agent.retrieve(WARM_TRANSFER_AGENT_ID);
    const version = (agent as unknown as Record<string, unknown>).version;
    if (typeof version === "number" && Number.isFinite(version) && version > 0) {
      cachedVersion = version;
      cachedAt = now;
      return version;
    }
  } catch (err) {
    console.warn(
      `[warm-transfer-agent-version] failed to fetch latest version of ${WARM_TRANSFER_AGENT_ID}, falling back to ${WARM_TRANSFER_AGENT_VERSION_FALLBACK}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return WARM_TRANSFER_AGENT_VERSION_FALLBACK;
}
