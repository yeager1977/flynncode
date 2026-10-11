import { base64Encode } from "@flynncode/core/util/encode"

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

// Computer use drives the user's real desktop, so the client never answers it on
// the user's behalf: no approval mode or auto-accept rule may cover it.
export function neverAutoResponds(permissionName?: string) {
  return permissionName === "computer_use"
}

export function rootSessionID(session: { id: string; parentID?: string }[], sessionID: string) {
  return sessionLineage(session, sessionID).at(-1) ?? sessionID
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string; permission?: string },
  directory?: string,
) {
  if (neverAutoResponds(permission.permission)) return false
  const value = sessionAutoAccept(autoAccept, session, permission, directory)
  if (value !== undefined) return value
  return directory ? isDirectoryAutoAccepting(autoAccept, directory) : false
}

export function sessionAutoAccept(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string; permission?: string },
  directory?: string,
) {
  if (neverAutoResponds(permission.permission)) return false
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
  if (neverAutoResponds(permissionName)) return false
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

// Approval mode is chosen per root session, so subagent requests follow the
// mode of the session whose dock shows them.
export function resolveApprovalMode(
  approvalMode: Record<string, ApprovalMode>,
  session: { id: string; parentID?: string }[],
  sessionID: string,
  directory?: string,
): ApprovalMode {
  return approvalMode[acceptKey(rootSessionID(session, sessionID), directory)] ?? "manual"
}

export function autoRespondVerdict(input: {
  autoAccept: Record<string, boolean>
  approvalMode: Record<string, ApprovalMode>
  session: { id: string; parentID?: string }[]
  permission: { sessionID: string; permission: string }
  directory?: string
}) {
  if (neverAutoResponds(input.permission.permission)) return false
  return resolveAutoRespond(
    sessionAutoAccept(input.autoAccept, input.session, input.permission, input.directory),
    approvalAutoRespond(
      resolveApprovalMode(input.approvalMode, input.session, input.permission.sessionID, input.directory),
      input.permission.permission,
    ),
    autoRespondsPermission(input.autoAccept, input.session, input.permission, input.directory),
  )
}
