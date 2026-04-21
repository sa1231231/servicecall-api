/**
 * One-time migration script: moves all client configs into MongoDB.
 *
 * Usage: npx tsx src/scripts/migrate-clients.ts
 *
 * Requires MONGODB_URL env var (set in .env or Railway).
 */
import "dotenv/config";
