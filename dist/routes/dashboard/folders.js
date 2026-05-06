import { ObjectId } from "mongodb";
import { getDb } from "../../lib/db.js";
import { loadClientsFromDb } from "../../config/client-store.js";
const COLLECTION = "agent_folders";
function col() {
    return getDb().collection(COLLECTION);
}
function clientsCol() {
    return getDb().collection("clients");
}
function isValidObjectIdString(id) {
    return typeof id === "string" && ObjectId.isValid(id) && new ObjectId(id).toString() === id;
}
function serialize(doc) {
    return {
        _id: doc._id.toString(),
        name: doc.name,
        position: doc.position,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}
// ── List ────────────────────────────────────────────────────────────────────
export async function listFoldersHandler(_req, res) {
    try {
        const folders = await col().find({}).sort({ position: 1 }).toArray();
        res.json(folders.map(serialize));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("[folders] list error:", msg);
        res.status(500).json({ error: "Failed to load folders" });
    }
}
// ── Create ──────────────────────────────────────────────────────────────────
export async function createFolderHandler(req, res) {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
        res.status(400).json({ error: "name (non-empty string) is required" });
        return;
    }
    try {
        // Append at the end: position = max(existing) + 1, or 0 if none.
        const last = await col().find({}).sort({ position: -1 }).limit(1).next();
        const position = last ? last.position + 1 : 0;
        const now = new Date();
        const result = await col().insertOne({
            _id: new ObjectId(),
            name,
            position,
            createdAt: now,
            updatedAt: now,
        });
        const inserted = await col().findOne({ _id: result.insertedId });
        if (!inserted) {
            res.status(500).json({ error: "Failed to load created folder" });
            return;
        }
        res.status(201).json(serialize(inserted));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("[folders] create error:", msg);
        res.status(500).json({ error: "Failed to create folder" });
    }
}
// ── Update (rename / reorder) ───────────────────────────────────────────────
export async function updateFolderHandler(req, res) {
    const id = req.params.id;
    if (!isValidObjectIdString(id)) {
        res.status(400).json({ error: "Invalid folder id" });
        return;
    }
    const updates = {};
    if (typeof req.body?.name === "string") {
        const trimmed = req.body.name.trim();
        if (!trimmed) {
            res.status(400).json({ error: "name cannot be empty" });
            return;
        }
        updates.name = trimmed;
    }
    if (typeof req.body?.position === "number" && Number.isFinite(req.body.position)) {
        updates.position = req.body.position;
    }
    if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: "No supported fields to update (name, position)" });
        return;
    }
    updates.updatedAt = new Date();
    try {
        const result = await col().findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updates }, { returnDocument: "after" });
        if (!result) {
            res.status(404).json({ error: "Folder not found" });
            return;
        }
        res.json(serialize(result));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("[folders] update error:", msg);
        res.status(500).json({ error: "Failed to update folder" });
    }
}
// ── Delete ──────────────────────────────────────────────────────────────────
// Sets folder_id: null on every client in the folder, then drops the folder.
// Agents fall back to the "Unfiled" pseudo-folder rendered on the dashboard.
export async function deleteFolderHandler(req, res) {
    const id = req.params.id;
    if (!isValidObjectIdString(id)) {
        res.status(400).json({ error: "Invalid folder id" });
        return;
    }
    try {
        const cleared = await clientsCol().updateMany({ folder_id: id }, { $set: { folder_id: null } });
        const result = await col().deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 0) {
            res.status(404).json({ error: "Folder not found" });
            return;
        }
        // Refresh the in-memory client cache so the dashboard reflects the change
        // immediately when it next reads notificationClients.
        await loadClientsFromDb();
        res.json({ success: true, agents_unfiled: cleared.modifiedCount });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("[folders] delete error:", msg);
        res.status(500).json({ error: "Failed to delete folder" });
    }
}
