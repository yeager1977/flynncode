import { base64Encode } from "@opencode-ai/core/util/encode"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  return autoAccept[key] ?? autoAccept[sessionID]
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  const value = sessionAutoAccept(autoAccept, session, permission, directory)
  if (value !== undefined) return value
  return directory ? isDirectoryAutoAccepting(autoAccept, directory) : false
}

export function sessionAutoAccept(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  return sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
}

export type ApprovalMode = "manual" | "accept-edits" | "auto"

// Same family as the server AUTO_EDIT_PERMISSIONS in permission evaluation:
// approval modes never cover shell or other mutating permissions.
export const AUTO_EDIT_PERMISSIONS: readonly string[] = ["edit", "read", "glob", "grep", "list"]

// Approval-mode verdict for a permission name, or undefined to fall through
// to the stored auto-accept rules.
export function approvalAutoRespond(mode: ApprovalMode, permissionName: string): boolean | undefined {
  if (mode === "auto") return true
  if (mode === "accept-edits" && AUTO_EDIT_PERMISSIONS.includes(permissionName)) return true
  return undefined
}

// Precedence: explicit per-session choice > approval mode > directory default.
export function resolveAutoRespond(
  override: boolean | undefined,
  approval: boolean | undefined,
  fallback: boolean,
): boolean {
  if (override !== undefined) return override
  if (approval !== undefined) return approval
  return fallback
}
