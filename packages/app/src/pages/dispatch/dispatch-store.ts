export type DispatchStatus = "running" | "done"

export type DispatchTask = {
  sessionID: string
  title: string
  status: DispatchStatus
}

export function addDispatch(tasks: DispatchTask[], task: DispatchTask) {
  return [task, ...tasks.filter((item) => item.sessionID !== task.sessionID)]
}

export function completeDispatch(tasks: DispatchTask[], sessionID: string) {
  return tasks.map((task) => (task.sessionID === sessionID ? { ...task, status: "done" as const } : task))
}
