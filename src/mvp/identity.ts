/**
 * The one line every get_context and memory_status reply carries, so an agent connected to the wrong server, or to a
 * Renor it did not expect, can tell (agent survey P1 and improvement 2, "Absence is silent"). The workspace name is the
 * one the gateway passes in `x-renor-workspace` (it deletes any client-sent copy first); an engine reached without the
 * gateway, or a control plane that does not return the name yet, gets none, and the line says so instead of guessing.
 */
const NO_NAME = 'hosted Renor, no workspace name passed';

export function identityLine(headers: Record<string, unknown> | undefined): string {
  const raw = headers?.['x-renor-workspace'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return NO_NAME;
  const name = value.replace(/[\u0000-\u001f\u007f"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return name === '' ? NO_NAME : `hosted Renor, workspace "${name}"`;
}
