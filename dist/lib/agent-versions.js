import { ObjectId } from "mongodb";
import { getDb } from "./db.js";
import { INTERNAL_VARS } from "./agent-generator/data-point-registry.js";
const COLLECTION = "agent_versions";
const MAX_VERSIONS_PER_AGENT = 50;
const TTL_DAYS = 90;
function col() {
    return getDb().collection(COLLECTION);
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function countNodes(canonical) {
    const flow = canonical.conversationFlow;
    if (!flow)
        return 0;
    const nodes = flow.nodes;
    return Array.isArray(nodes) ? nodes.length : 0;
}
function countDataPoints(canonical) {
    const flow = canonical.conversationFlow;
    if (!flow)
        return 0;
    const nodes = flow.nodes;
    if (!Array.isArray(nodes))
        return 0;
    const seen = new Set();
    for (const node of nodes) {
        if (node.type !== "extract_dynamic_variables")
            continue;
        const vars = node.variables;
        if (!Array.isArray(vars))
            continue;
        for (const v of vars) {
            if (!INTERNAL_VARS.has(v.name))
                seen.add(v.name);
        }
    }
    return seen.size;
}
// ── Public API ───────────────────────────────────────────────────────────────
export async function createVersionSnapshot(slug, agentId, canonicalJson, source, description, createdBy) {
    const version = await getNextVersionNumber(slug, agentId);
    const doc = {
        slug,
        agentId,
        version,
        canonicalJson,
        source,
        description,
        createdBy,
        createdAt: new Date(),
        nodeCount: countNodes(canonicalJson),
        dataPointCount: countDataPoints(canonicalJson),
    };
    const result = await col().insertOne(doc);
    // Enforce max versions: delete oldest beyond threshold
    const count = await col().countDocuments({ slug, agentId });
    if (count > MAX_VERSIONS_PER_AGENT) {
        const oldest = await col()
            .find({ slug, agentId })
            .sort({ version: 1 })
            .limit(count - MAX_VERSIONS_PER_AGENT)
            .toArray();
        if (oldest.length > 0) {
            await col().deleteMany({
                _id: { $in: oldest.map((d) => d._id) },
            });
        }
    }
    return { ...doc, _id: result.insertedId };
}
export async function listVersions(slug, agentId, opts) {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    const [versions, total] = await Promise.all([
        col()
            .find({ slug, agentId })
            .sort({ version: -1 })
            .skip(offset)
            .limit(limit)
            .toArray(),
        col().countDocuments({ slug, agentId }),
    ]);
    return { versions, total };
}
export async function getVersion(versionId) {
    return col().findOne({ _id: new ObjectId(versionId) });
}
export async function getLatestVersion(slug, agentId) {
    return col().findOne({ slug, agentId }, { sort: { version: -1 } });
}
async function getNextVersionNumber(slug, agentId) {
    const latest = await col().findOne({ slug, agentId }, { sort: { version: -1 }, projection: { version: 1 } });
    return latest ? latest.version + 1 : 1;
}
// ── Indexes ──────────────────────────────────────────────────────────────────
export async function ensureVersionIndexes() {
    await col().createIndex({ slug: 1, agentId: 1, version: -1 });
    await col().createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 });
    console.log("[agent-versions] indexes ensured");
}
