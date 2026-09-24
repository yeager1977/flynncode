export type SubagentStatus = "busy" | "retry" | "idle"

export type SubagentChild = {
  id: string
  title: string
  updated: number
  status: SubagentStatus | undefined
  text: string
}

export type SubagentGroups = {
  active: SubagentChild[]
  finished: SubagentChild[]
}

export function groupSubagents(children: readonly SubagentChild[]): SubagentGroups {
  const byUpdated = (a: SubagentChild, b: SubagentChild) => b.updated - a.updated
  const active = children.filter((child) => child.status === "busy" || child.status === "retry").toSorted(byUpdated)
  const finished = children.filter((child) => child.status !== "busy" && child.status !== "retry").toSorted(byUpdated)
  return { active, finished }
}

export function subagentPreview(text: string) {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  return line ?? ""
}

export function expandSubagent(
  state: { expandedID?: string; finishedOpen: boolean },
  child: { id: string; finished: boolean },
) {
  return {
    expandedID: child.id,
    finishedOpen: state.finishedOpen || child.finished,
  }
}

export function hasSubagents(sessionID: string, sessions: readonly { parentID?: string }[]) {
  return sessions.some((session) => session.parentID === sessionID)
}

export function sessionShowsSubagents(
  sessionID: string,
  sessions: readonly { parentID?: string }[],
  messages: Record<string, readonly { id: string }[] | undefined> | undefined,
  parts: Record<string, readonly TaskToolPart[] | undefined> | undefined,
) {
  if (!sessionID) return false
  if (hasSubagents(sessionID, sessions)) return true
  const own = (messages?.[sessionID] ?? []).flatMap((message) => parts?.[message.id] ?? [])
  return tasksFromParts(own, 0).length > 0
}

export type TaskToolPart = {
  type?: string
  tool?: string
  text?: string
  state?: {
    status?: string
    title?: string
    output?: string
    metadata?: {
      sessionId?: string
      background?: boolean
    }
  }
}

// A background task tool reports completed as soon as the child starts.
export function tasksFromParts(parts: readonly TaskToolPart[], updated: number): SubagentChild[] {
  const tasks = new Map<string, { title: string; text: string; running: boolean }>()
  for (const part of parts) {
    const output = part.state?.output ?? (typeof part.text === "string" ? part.text : "")
    const title = part.state?.title
    for (const match of output.matchAll(/<task id="([^"]+)" state="(running|completed|error)"/g)) {
      const id = match[1]
      if (!id) continue
      const current = tasks.get(id)
      tasks.set(id, {
        title: title || current?.title || id,
        text: output || current?.text || "",
        running: match[2] === "running",
      })
    }
    const sessionId = part.type === "tool" && part.tool === "task" ? part.state?.metadata?.sessionId : undefined
    if (typeof sessionId !== "string") continue
    const current = tasks.get(sessionId)
    if (current && !current.running) continue
    const status = part.state?.status
    const background = part.state?.metadata?.background === true
    const running = status === "running" || status === "pending" || (background && status !== "error")
    tasks.set(sessionId, {
      title: title || current?.title || sessionId,
      text: output || current?.text || "",
      running,
    })
  }
  return [...tasks.values()].length
    ? [...tasks.entries()]
        .filter(([, item]) => item.running)
        .map(([id, item]) => ({
          id,
          title: item.title,
          updated,
          status: "busy" as const,
          text: item.text,
        }))
    : []
}

export function mergeSubagents(sessions: readonly SubagentChild[], tasks: readonly SubagentChild[]) {
  const byID = new Map(sessions.map((child) => [child.id, child]))
  for (const task of tasks) {
    const current = byID.get(task.id)
    if (!current) {
      byID.set(task.id, task)
      continue
    }
    byID.set(task.id, {
      ...current,
      title: current.title || task.title,
      text: current.text || task.text,
      status: current.status === "busy" || current.status === "retry" ? current.status : "busy",
    })
  }
  return [...byID.values()]
}