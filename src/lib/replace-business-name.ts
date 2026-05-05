/**
 * Find-and-replace a business name across an arbitrary JSON object.
 *
 * Used both by the clone flow (renaming a duplicated agent) and by the
 * in-place rename flow (propagating a name change to every prompt, the
 * welcome message, the FAQ, agent_name, etc.).
 *
 * The match is case-insensitive but the replacement uses the new name's
 * casing verbatim. This intentionally also rewrites incidental mentions
 * inside FAQ text and custom prompts — usually what callers want.
 */
export function replaceBusinessName(
  obj: Record<string, unknown>,
  oldName: string,
  newName: string,
): Record<string, unknown> {
  const serialized = JSON.stringify(obj);
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "gi");
  return JSON.parse(serialized.replace(regex, newName));
}
