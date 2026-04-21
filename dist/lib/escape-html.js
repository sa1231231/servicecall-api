const escapeMap = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};
export function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (ch) => escapeMap[ch]);
}
