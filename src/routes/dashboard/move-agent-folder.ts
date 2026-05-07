import type { Request, Response } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/db.js";
import { getClientDocument, updateClientFields } from "../../config/client-store.js";
import { logAudit } from "../../lib/audit.js";

// PATCH /dashboard/api/agents/:slug/folder
// Body: { folder_id: string | null }
// Moves a client into the named folder, or to root (Unfiled) when null.
// 404 if the client doesn't exist; 400 if folder_id is non-null and the
// folder doesn't exist.
export async function moveAgentFolderHandler(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.slug);
  const raw = req.body?.folder_id;

  let folderId: string | null;
  if (raw === null || raw === undefined || raw === "") {
    folderId = null;
  } else if (typeof raw === "string" && ObjectId.isValid(raw) && new ObjectId(raw).toString() === raw) {
    folderId = raw;
  } else {
    res.status(400).json({ error: "folder_id must be a valid ObjectId string or null" });
    return;
  }

  const client = await getClientDocument(slug);
  if (!client) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }

  if (folderId !== null) {
    const exists = await getDb()
      .collection("agent_folders")
      .findOne({ _id: new ObjectId(folderId) });
    if (!exists) {
      res.status(400).json({ error: `Folder "${folderId}" not found` });
      return;
    }
  }

  try {
    await updateClientFields(slug, { folder_id: folderId });
    await logAudit(req, "move_agent_folder", slug, {
      from: (client as { folder_id?: string | null }).folder_id ?? null,
      to: folderId,
    });
    res.json({ success: true, slug, folder_id: folderId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[move-agent-folder] error:", msg);
    res.status(500).json({ error: "Failed to move agent" });
  }
}
