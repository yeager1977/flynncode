import { pathKey } from "@/utils/path-key"

// Where the open session route should move when the session's directory
// changes underneath it (the agent's enter_worktree/exit_worktree switches the
// primary folder mid-turn). Only a view sitting on the folder the session just
// left follows; a route already elsewhere, or a change to the same folder,
// stays put.
export function sessionFollowHref(input: {
  routeDirectory: string
  sessionID: string | undefined
  from: string | undefined
  to: string | undefined
  href: (session: { directory: string; id: string }) => string
}): string | undefined {
  if (!input.sessionID || !input.from || !input.to) return undefined
  if (pathKey(input.from) === pathKey(input.to)) return undefined
  if (pathKey(input.routeDirectory) !== pathKey(input.from)) return undefined
  return input.href({ directory: input.to, id: input.sessionID })
}
