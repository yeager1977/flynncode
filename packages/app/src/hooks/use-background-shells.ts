import { createEffect, createSignal, on, onCleanup } from "solid-js"
import type {
  BackgroundShell,
  EventShellBackgroundExited,
  EventShellBackgroundOutput,
  EventShellBackgroundStarted,
} from "@flynncode/sdk/v2/client"
import { useSDK } from "@/context/sdk"

export const TAIL_LINES = 200

export type ShellEntry = BackgroundShell & { tail: string }

export type ShellEvent =
  | Pick<EventShellBackgroundStarted, "type" | "properties">
  | Pick<EventShellBackgroundOutput, "type" | "properties">
  | Pick<EventShellBackgroundExited, "type" | "properties">

export function useBackgroundShells(sessionID: () => string | undefined) {
  const sdk = useSDK()
  const [shells, setShells] = createSignal<ShellEntry[]>([])
  // Any event or newer request invalidates in-flight list responses, so a slow
  // list that predates an `exited` event cannot flip the shell back to running.
  let generation = 0

  const refresh = async () => {
    const id = sessionID()
    if (!id) return
    const run = ++generation
    const result = await sdk()
      .client.session.shells.list({ sessionID: id })
      .catch(() => undefined)
    if (!result || run !== generation || id !== sessionID()) return
    setShells((current) => mergeShellList(current, result.data ?? []))
  }

  const loadTail = async (shellID: string) => {
    const id = sessionID()
    if (!id) return
    const result = await sdk()
      .client.session.shells.output({ sessionID: id, id: shellID })
      .catch(() => undefined)
    if (!result || id !== sessionID()) return
    const text = clipTail(result.data?.text ?? "")
    setShells((current) => current.map((item) => (item.id === shellID ? { ...item, tail: text } : item)))
  }

  const stop = async (shellID: string) => {
    const id = sessionID()
    if (!id) return false
    const result = await sdk()
      .client.session.shells.stop({ sessionID: id, id: shellID })
      .catch(() => undefined)
    void refresh()
    return !!result
  }

  createEffect(
    on(sessionID, (id) => {
      generation++
      setShells([])
      if (id) void refresh()
    }),
  )

  createEffect(() => {
    const events = sdk().event
    const apply = (event: ShellEvent) => {
      if (event.properties.sessionID !== sessionID()) return false
      generation++
      setShells((current) => applyShellEvent(event.properties.sessionID, current, event))
      return true
    }
    const off = [
      events.on("shell.background.started", (event) => {
        // The event carries no output path, so the list fills that in.
        if (apply(event)) void refresh()
      }),
      events.on("shell.background.output", (event) => {
        apply(event)
      }),
      events.on("shell.background.exited", (event) => {
        // The last throttled output may only arrive with the exit.
        if (!apply(event)) return
        void refresh()
        void loadTail(event.properties.id)
      }),
    ]
    onCleanup(() => off.forEach((fn) => fn()))
  })

  return { shells, refresh, loadTail, stop }
}

export function applyShellEvent(
  sessionID: string,
  list: ShellEntry[],
  event: ShellEvent,
  now = Date.now(),
): ShellEntry[] {
  if (event.properties.sessionID !== sessionID) return list
  if (event.type === "shell.background.started") {
    const known = list.some((item) => item.id === event.properties.id)
    if (known) return list
    return [
      ...list,
      {
        id: event.properties.id,
        sessionID,
        command: event.properties.command,
        pid: event.properties.pid,
        outputPath: "",
        startedAt: event.properties.startedAt,
        status: "running",
        tail: "",
      },
    ]
  }
  if (!list.some((item) => item.id === event.properties.id)) return list
  if (event.type === "shell.background.output")
    return list.map((item) =>
      item.id === event.properties.id ? { ...item, tail: appendTail(item.tail, event.properties.tail) } : item,
    )
  return list.map((item) =>
    item.id === event.properties.id
      ? { ...item, status: event.properties.status, exitCode: event.properties.exitCode, endedAt: item.endedAt ?? now }
      : item,
  )
}

// The server list is authoritative for membership and status. Tails only come
// from output reads/events, so keep them for shells that survive and drop the
// rest rather than leaking state for shells that no longer exist.
export function mergeShellList(current: ShellEntry[], fetched: BackgroundShell[]): ShellEntry[] {
  const tails = new Map(current.map((item) => [item.id, item.tail]))
  return fetched.map((item) => ({ ...item, tail: tails.get(item.id) ?? "" }))
}

// Output events carry only the last few KiB, so splice them onto what is
// already shown instead of shrinking a longer tail loaded from the route.
export function appendTail(previous: string, incoming: string) {
  const next = incoming.replace(/\n$/, "")
  if (!previous) return clipTail(next)
  if (!next) return previous
  // Longest suffix of `previous` that `next` starts with; only the last next.length chars can overlap.
  const start = Math.max(0, previous.length - next.length)
  const at = Array.from({ length: previous.length - start }, (_, index) => start + index).find((from) =>
    next.startsWith(previous.slice(from)),
  )
  return clipTail(at === undefined ? next : previous.slice(0, at) + next)
}

export function clipTail(text: string, lines = TAIL_LINES) {
  return text.replace(/\n$/, "").split("\n").slice(-lines).join("\n")
}

export function shellElapsed(shell: Pick<BackgroundShell, "startedAt" | "endedAt">, now: number) {
  return (shell.endedAt ?? now) - shell.startedAt
}

export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number) => String(value).padStart(2, "0")
  if (hours > 0) return `${hours}h ${pad(minutes)}m`
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
}

export function runningCount(shells: Pick<BackgroundShell, "status">[]) {
  return shells.filter((item) => item.status === "running").length
}
