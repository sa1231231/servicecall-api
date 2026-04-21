import { getAllClientSummaries } from "../../config/client-store.js";
export function listAgentsHandler(_req, res) {
    res.json(getAllClientSummaries());
}
