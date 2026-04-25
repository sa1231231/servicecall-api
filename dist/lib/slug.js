import crypto from "crypto";
export function generateSlug(name) {
    const base = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const hash = crypto.randomBytes(4).toString("hex").slice(0, 7);
    return `${base || "agent"}-${hash}`;
}
