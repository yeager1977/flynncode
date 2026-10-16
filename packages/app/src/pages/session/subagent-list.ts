export type SubagentStatus = "busy" | "retry" | "idle"

export type SubagentChild = {
  id: string
  title: string
  updated: number
  // Task-only rows have no session entry, so implicit-local subagents carry
  // no directory.
  directory?: string
  status: SubagentStatus | undefined
  text: string
  // "provider/model" of the child's newest assistant turn: the model that is
  // doing (or last did) the work, which can differ from any picker selection.
  model?: string
  // The child's newest assistant turn ended on a provider usage limit.
  limited?: boolean
}

// Assistant messages record the model they started with, so the newest one
// names the model behind the current (or most recent) run even if the user
// has since switched the session's selected model.
export function latestAssistantModel(
  messages: readonly { role: string; providerID?: string; modelID?: string }[] | undefined,
) {
  const last = messages?.findLast((message) => message.role === "assistant" && message.providerID && message.modelID)
  if (!last?.providerID || !last.modelID) return undefined
  return `${last.providerID}/${last.modelID}`
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

// A usage-limited child has stopped (idle), so it only reads as limited while
// it is not working again, e.g. after a resume with another model.
export function subagentState(child: Pick<SubagentChild, "status" | "limited">) {
  if (child.status === "busy" || child.status === "retry") return "running" as const
  if (child.limited) return "usage-limit" as const
  return "idle" as const
}

export function subagentListState(children: readonly SubagentChild[]) {
  return children.length === 0 ? "empty" : "list"
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
    expandedID: state.expandedID === child.id ? undefined : child.id,
    finishedOpen: state.finishedOpen || child.finished,
  }
}

export type TaskToolPart = {
  type?: string
  tool?: string
  text?: string
  state?: {
    status?: string
    title?: string
    output?: string
    input?: {
      model?: string
    }
    metadata?: {
      sessionId?: string
      background?: boolean
    }
  }
}

// A background task tool reports completed as soon as the child starts, and its
// "running" notice persists after the child ends, so background tasks count as
// running only while the child's live session status is busy or retrying.
export function tasksFromParts(
  parts: readonly TaskToolPart[],
  updated: number,
  live: (sessionID: string) => boolean,
): SubagentChild[] {
  const tasks = new Map<string, { title: string; text: string; running: boolean; model?: string }>()
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
        running: match[2] === "running" && live(id),
      })
    }
    const sessionId = part.type === "tool" && part.tool === "task" ? part.state?.metadata?.sessionId : undefined
    if (typeof sessionId !== "string") continue
    const current = tasks.get(sessionId)
    if (current && !current.running) continue
    const status = part.state?.status
    const background = part.state?.metadata?.background === true
    const running =
      status === "running" || status === "pending" || (background && status !== "error" && live(sessionId))
    tasks.set(sessionId, {
      title: title || current?.title || sessionId,
      text: output || current?.text || "",
      running,
      model: part.state?.input?.model || current?.model,
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
          model: item.model,
        }))
    : []
}

// Children whose parent task output reports a usage-limit stop. The report text
// survives reload, unlike the child's own (often unloaded) messages. Parts are
// in chronological order, so a later result for a resumed task overrides it.
export function limitedTaskIDs(parts: readonly TaskToolPart[]) {
  const limited = new Set<string>()
  for (const part of parts) {
    const output = part.state?.output ?? (typeof part.text === "string" ? part.text : "")
    const stopped = output.includes("Subagent stopped: usage limit")
    const sessionId = part.type === "tool" && part.tool === "task" ? part.state?.metadata?.sessionId : undefined
    const ids = [
      ...Array.from(output.matchAll(/<task id="([^"]+)" state="(?:running|completed|error)"/g), (match) => match[1]),
      ...(typeof sessionId === "string" ? [sessionId] : []),
    ]
    for (const id of ids) {
      if (!id) continue
      if (stopped) limited.add(id)
      else if (output.includes("<task id=")) limited.delete(id)
    }
  }
  return limited
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
      status: current.status ?? task.status,
      model: current.model ?? task.model,
    })
  }
  return [...byID.values()]
}
