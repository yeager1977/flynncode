import type { Message, Part, PermissionRequest, QuestionRequest, Session } from "@flynncode/sdk/v2/client"
import { shellPtyID } from "@/pages/session/helpers"

function sessionTreeRequest<T>(
  session: Session[],
  request: Record<string, T[] | undefined>,
  sessionID?: string,
  include: (item: T) => boolean = () => true,
) {
  if (!sessionID) return

  const map = session.reduce((acc, item) => {
    if (!item.parentID) return acc
    const list = acc.get(item.parentID)
    if (list) list.push(item.id)
    if (!list) acc.set(item.parentID, [item.id])
    return acc
  }, new Map<string, string[]>())

  const seen = new Set([sessionID])
  const ids = [sessionID]
  for (const id of ids) {
    const list = map.get(id)
    if (!list) continue
    for (const child of list) {
      if (seen.has(child)) continue
      seen.add(child)
      ids.push(child)
    }
  }

  const id = ids.find((id) => request[id]?.some(include))
  if (!id) return
  return request[id]?.find(include)
}

// The descendants of a session, excluding the session itself.
function descendants(session: Session[], sessionID?: string) {
  if (!sessionID) return []

  const map = session.reduce((acc, item) => {
    if (!item.parentID) return acc
    const list = acc.get(item.parentID)
    if (list) list.push(item.id)
    if (!list) acc.set(item.parentID, [item.id])
    return acc
  }, new Map<string, string[]>())

  const seen = new Set([sessionID])
  const ids: string[] = []
  for (const id of [sessionID]) {
    for (const child of map.get(id) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      ids.push(child)
    }
  }
  // Grow the frontier as each descendant is discovered, so grandchildren are
  // included too.
  for (let index = 0; index < ids.length; index++) {
    for (const child of map.get(ids[index]) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      ids.push(child)
    }
  }
  return ids
}

export function sessionPermissionRequest(
  session: Session[],
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: PermissionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}

export function sessionQuestionRequest(
  session: Session[],
  request: Record<string, QuestionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: QuestionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}

// A subagent running an interactive shell holds a PTY and waits for the user to
// type into it. The main session surfaces that so the terminal is reachable
// without hunting for the subagent's session.
//
// The shell part stays a candidate after the tool call ends: the shell tool
// leaves the terminal open on timeout, so the live PTY decides whether the
// wait is still on.
export function sessionWaitingTerminal(
  session: Session[],
  messages: Record<string, Message[] | undefined>,
  parts: Record<string, Part[] | undefined>,
  sessionID?: string,
) {
  for (const child of descendants(session, sessionID)) {
    for (const message of messages[child] ?? []) {
      for (const part of parts[message.id] ?? []) {
        if (part.type !== "tool" || (part.tool !== "bash" && part.tool !== "shell")) continue
        if (part.sessionID !== child) continue
        if (part.state.status === "pending") continue
        if (part.state.metadata?.interactive !== true) continue
        const ptyID = shellPtyID(part.state.metadata)
        if (!ptyID) continue
        const command = part.state.input?.command
        const title = "title" in part.state ? part.state.title : undefined
        return {
          sessionID: child,
          ptyID,
          command: typeof command === "string" ? command : title,
        }
      }
    }
  }
}

// The wait is over once the terminal is gone. A PTY the server no longer
// lists has exited, so the card must not point at a dead terminal.
export function isLiveTerminal(ptyID: string, live: ReadonlySet<string>) {
  return live.has(ptyID)
}
