import { type StoredRoutine } from "@/components/settings-v2/routines-edit"
import { type ActivityStatus, type InboxKind } from "./activity-status"
import { type DispatchTask } from "./dispatch-store"

export type InboxRow = {
  key: string
  kind: InboxKind
  title: string
  subtitle: string
  status: ActivityStatus
  unread: boolean
  sessionID?: string
  directory?: string
}

export type InboxFilter = "all" | "running" | "needs-input" | "blocked" | "done" | "unread"

export type InboxSession = {
  id: string
  title: string
  directory: string
}

export function dispatchRows(
  tasks: readonly DispatchTask[],
  liveOf: (id: string) => ActivityStatus,
  unseenOf: (id: string) => number,
): InboxRow[] {
  return tasks.map((task) => ({
    key: task.sessionID,
    kind: "dispatch",
    title: task.title,
    subtitle: task.directory,
    status: liveOf(task.sessionID),
    unread: task.unread || unseenOf(task.sessionID) > 0,
    sessionID: task.sessionID,
    directory: task.directory,
  }))
}

export function routineRows(
  routines: readonly StoredRoutine[],
  scheduleOf: (routine: StoredRoutine) => string,
): InboxRow[] {
  return routines.map((routine) => {
    const runs = routine.recentRuns ?? []
    const latest = runs[runs.length - 1]
    const failed = latest?.state === "error"
    return {
      key: `routine:${routine.id}`,
      kind: "routine",
      title: routine.name,
      subtitle: scheduleOf(routine),
      status: failed ? "failed" : "done",
      unread: failed,
    }
  })
}

export function sessionRows(
  sessions: readonly InboxSession[],
  statusOf: (id: string) => ActivityStatus,
  unseenOf: (id: string) => number,
): InboxRow[] {
  return sessions.map((session) => ({
    key: `session:${session.id}`,
    kind: "session",
    title: session.title,
    subtitle: session.directory,
    status: statusOf(session.id),
    unread: unseenOf(session.id) > 0,
    sessionID: session.id,
    directory: session.directory,
  }))
}

const rank: Record<ActivityStatus, number> = {
  "needs-input": 0,
  blocked: 1,
  running: 2,
  done: 3,
  failed: 3,
}

function compareInbox(a: InboxRow, b: InboxRow) {
  const order = rank[a.status] - rank[b.status]
  if (order !== 0) return order
  if (a.unread !== b.unread) return a.unread ? -1 : 1
  return 0
}

export function filterInbox(rows: readonly InboxRow[], filter: InboxFilter): InboxRow[] {
  const kept =
    filter === "all"
      ? [...rows]
      : filter === "unread"
        ? rows.filter((row) => row.unread)
        : rows.filter((row) => row.status === filter)
  return kept.sort(compareInbox)
}

export function inboxUnread(rows: readonly InboxRow[]): number {
  return rows.filter((row) => row.unread).length
}
