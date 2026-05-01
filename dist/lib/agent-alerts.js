// ── Per-Agent Call Surge & Cost Surge Alerts ─────────────────────────────────
// Tracks call volume and cost per agent_id in-memory.
// Automatically monitors all agents via the webhook — no per-agent setup needed.
const CALL_SURGE_THRESHOLD = 15;
const CALL_SURGE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CALL_SURGE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown after alert
const COST_SURGE_THRESHOLD_CENTS = 1000; // $10.00
// ── Call surge: sliding 1-hour window of timestamps per agent ────────────────
const callTimestamps = new Map();
const callSurgeLastAlerted = new Map();
// ── Cost surge: daily accumulator per agent ──────────────────────────────────
const dailyCost = new Map();
function todayDateString() {
    return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}
export function checkAgentAlerts(agentId, callCostCents) {
    const now = Date.now();
    const result = {
        callSurge: { fired: false, count: 0 },
        costSurge: { fired: false, totalCents: 0 },
    };
    // ── Call surge check ─────────────────────────────────────────────────────
    const cutoff = now - CALL_SURGE_WINDOW_MS;
    let timestamps = callTimestamps.get(agentId);
    if (!timestamps) {
        timestamps = [];
        callTimestamps.set(agentId, timestamps);
    }
    timestamps.push(now);
    // Trim entries older than 1 hour
    const trimmed = timestamps.filter((t) => t > cutoff);
    callTimestamps.set(agentId, trimmed);
    result.callSurge.count = trimmed.length;
    if (trimmed.length >= CALL_SURGE_THRESHOLD) {
        const lastAlert = callSurgeLastAlerted.get(agentId) ?? 0;
        if (now - lastAlert > CALL_SURGE_COOLDOWN_MS) {
            callSurgeLastAlerted.set(agentId, now);
            result.callSurge.fired = true;
        }
    }
    // ── Cost surge check ─────────────────────────────────────────────────────
    if (callCostCents != null && callCostCents > 0) {
        const today = todayDateString();
        let entry = dailyCost.get(agentId);
        if (!entry || entry.date !== today) {
            entry = { date: today, totalCents: 0, alerted: false };
            dailyCost.set(agentId, entry);
        }
        entry.totalCents += callCostCents;
        result.costSurge.totalCents = entry.totalCents;
        if (entry.totalCents >= COST_SURGE_THRESHOLD_CENTS && !entry.alerted) {
            entry.alerted = true;
            result.costSurge.fired = true;
        }
    }
    return result;
}
