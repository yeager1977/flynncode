import type { PermissionRequest } from "@flynncode/sdk/v2"

type DockRequest = Pick<PermissionRequest, "permission" | "metadata" | "always">

// A hook that forces this prompt (`ask`) puts its reason in the metadata.
export function permissionHookReason(request: DockRequest) {
  const reason = request.metadata.reason
  if (typeof reason !== "string") return undefined
  return reason.trim() || undefined
}

// "Allow always" remembers the request's `always` patterns. With none (a
// hook-forced prompt, for one) it would only allow once, so it is not offered.
export function offersAlwaysApproval(request: DockRequest) {
  return request.permission !== "computer_use" && request.always.length > 0
}
