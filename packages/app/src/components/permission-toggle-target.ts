export function permissionToggleTarget(sessionID: string | undefined): "session" | "directory" {
  return sessionID ? "session" : "directory"
}
