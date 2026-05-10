import { ObjectId, type WithId } from "mongodb";
import { getDb } from "./db.js";
import { INTERNAL_VARS } from "./agent-generator/data-point-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentVersionDoc {
  slug: string;
  agentId: string;
  version: number;
  canonicalJson: Record<string, unknown>;
  source: "manual_edit" | "rollback" | "auto_sync" | "creation";
  description: string;
  createdBy: string;
  createdAt: Date;
  nodeCount: number;
  dataPointCount: number;
}

const COLLECTION = "agent_versions";
const MAX_VERSIONS_PER_AGENT = 50;
const TTL_DAYS = 90;

function col() {
  return getDb().collection<AgentVersionDoc>(COLLECTION);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function countNodes(canonical: Record<string, unknown>): number {
  const flow = canonical.conversationFlow as Record<string, unknown> | undefined;
  if (!flow) return 0;
  const nodes = flow.nodes as unknown[] | undefined;
  return Array.isArray(nodes) ? nodes.length : 0;
}

function countDataPoints(canonical: Record<string, unknown>): number {
  const flow = canonical.conversationFlow as Record<string, unknown> | undefined;
  if (!flow) return 0;
  const nodes = flow.nodes as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(nodes)) return 0;

  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "extract_dynamic_variables") continue;
    const vars = node.variables as Array<{ name: string }> | undefined;
    if (!Array.isArray(vars)) continue;
    for (const v of vars) {
      if (!INTERNAL_VARS.has(v.name)) seen.add(v.name);
    }
  }
  return seen.size;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function createVersionSnapshot(
  slug: string,
  agentId: string,
  canonicalJson: Record<string, unknown>,
  source: AgentVersionDoc["source"],
  description: string,
  createdBy: string,
): Promise<WithId<AgentVersionDoc>> {
  const version = await getNextVersionNumber(slug, agentId);

  const doc: AgentVersionDoc = {
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

export async function listVersions(
  slug: string,
  agentId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ versions: WithId<AgentVersionDoc>[]; total: number }> {
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

export async function getVersion(
  versionId: string,
): Promise<WithId<AgentVersionDoc> | null> {
  return col().findOne({ _id: new ObjectId(versionId) });
}

export async function getLatestVersion(
  slug: string,
  agentId: string,
): Promise<WithId<AgentVersionDoc> | null> {
  return col().findOne(
    { slug, agentId },
    { sort: { version: -1 } },
  );
}

// Find the snapshot taken just before a given version. Used by the
// suggestion-rollback path: an applied suggestion stores `applied_version_id`
// pointing at the post-apply snapshot, and rollback wants the version that
// existed *before* that publish.
//
// Returns null if `versionId` doesn't exist, refers to a different
// slug+agent, or is the very first version (nothing to roll back to).
export async function getPreviousVersion(
  versionId: string,
): Promise<WithId<AgentVersionDoc> | null> {
  if (!ObjectId.isValid(versionId)) return null;
  const target = await col().findOne({ _id: new ObjectId(versionId) });
  if (!target) return null;
  return col().findOne(
    {
      slug: target.slug,
      agentId: target.agentId,
      version: { $lt: target.version },
    },
    { sort: { version: -1 } },
  );
}

async function getNextVersionNumber(
  slug: string,
  agentId: string,
): Promise<number> {
  const latest = await col().findOne(
    { slug, agentId },
    { sort: { version: -1 }, projection: { version: 1 } },
  );
  return latest ? latest.version + 1 : 1;
}

// ── Indexes ──────────────────────────────────────────────────────────────────

export async function ensureVersionIndexes(): Promise<void> {
  await col().createIndex({ slug: 1, agentId: 1, version: -1 });
  await col().createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: TTL_DAYS * 86400 },
  );
  console.log("[agent-versions] indexes ensured");
}
