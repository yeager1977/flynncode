import { upstreamUrl } from "./upstream.ts"

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

const TIMEOUT_MS = 5000
const RECENT_LIMIT = 30

export type LauncherLoad =
  | { kind: "loaded"; data: LauncherData; partial: boolean }
  | { kind: "unreachable" }

export async function loadLauncher(input: { upstream: string; authorization: string }): Promise<LauncherLoad> {
  const [active, recent] = await Promise.all([
    request(input, "http://gateway/api/session/active"),
    request(input, `http://gateway/api/session?limit=${RECENT_LIMIT}&order=desc`),
  ])

  if (active === undefined && recent === undefined) return { kind: "unreachable" }

  return {
    kind: "loaded",
    partial: active === undefined || recent === undefined,
    data: groupSessions({ sessions: parseSessions(recent), running: parseActive(active) }),
  }
}

async function request(input: { upstream: string; authorization: string }, url: string) {
  try {
    const response = await fetch(upstreamUrl(input.upstream, url), {
      headers: { authorization: input.authorization },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return
    return (await response.json()) as unknown
  } catch {
    return
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseActive(value: unknown) {
  if (!isRecord(value) || !isRecord(value.data)) return []
  return Object.keys(value.data)
}

function parseSessions(value: unknown): LauncherSession[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  const sessions: LauncherSession[] = []
  for (const item of value.data) {
    if (!isRecord(item)) continue
    if (typeof item.id !== "string" || !item.id) continue
    const location = isRecord(item.location) ? item.location : undefined
    const time = isRecord(item.time) ? item.time : undefined
    sessions.push({
      id: item.id,
      title: typeof item.title === "string" && item.title.trim() ? item.title : item.id,
      directory: location && typeof location.directory === "string" ? location.directory : undefined,
      updated: time && typeof time.updated === "number" && Number.isFinite(time.updated) ? time.updated : 0,
    })
  }
  return sessions
}