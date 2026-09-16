export type LauncherSession = {
  id: string
  title: string
  directory: string | undefined
  updated: number
}

export type LauncherGroup = {
  directory: string
  label: string
  sessions: LauncherSession[]
}

export type LauncherData = {
  running: LauncherSession[]
  groups: LauncherGroup[]
}

const UNKNOWN_PROJECT = "Unknown project"
const PLACEHOLDER_TITLE_LENGTH = 12

export function sessionSlug(directory: string) {
  const bytes = new TextEncoder().encode(directory)
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function projectLabel(directory: string | undefined) {
  if (directory === undefined) return UNKNOWN_PROJECT
  if (directory === "/") return "/"
  const trimmed = directory.replace(/\/+$/, "")
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  return segment || directory
}

export function relativeTime(updated: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - updated) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function groupSessions(input: { sessions: LauncherSession[]; running: string[] }): LauncherData {
  const active = new Set(input.running)
  const known = new Map(input.sessions.map((session) => [session.id, session]))
  const running = input.running.map((id) => known.get(id) ?? placeholder(id))
  const byDirectory = new Map<string, LauncherGroup>()

  for (const session of input.sessions) {
    if (active.has(session.id)) continue
    const key = session.directory ?? ""
    const group = byDirectory.get(key)
    if (group) {
      group.sessions.push(session)
      continue
    }
    byDirectory.set(key, { directory: key, label: projectLabel(session.directory), sessions: [session] })
  }

  const groups = [...byDirectory.values()].map((group) => ({
    ...group,
    sessions: [...group.sessions].sort((a, b) => b.updated - a.updated),
  }))

  groups.sort((a, b) => {
    if (a.directory === "") return 1
    if (b.directory === "") return -1
    return newest(b.sessions) - newest(a.sessions)
  })

  return { running, groups }
}

function newest(sessions: LauncherSession[]) {
  return sessions.reduce((max, session) => (session.updated > max ? session.updated : max), 0)
}

function placeholder(id: string) {
  return {
    id,
    title: id.slice(0, PLACEHOLDER_TITLE_LENGTH),
    directory: undefined,
    updated: 0,
  }
}