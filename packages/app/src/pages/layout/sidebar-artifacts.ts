import type { Session } from "@flynncode/sdk/v2/client"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { createSignal } from "solid-js"
import { pathKey } from "@/utils/path-key"
import { compareSessionTime } from "./helpers"

export type SessionDiffData = {
  session?: Session[]
  path?: { directory: string }
  session_diff: { [sessionID: string]: FileDiffInfo[] }
}

export type ArtifactRect = {
  x: number
  y: number
  width: number
  height: number
}

export type DiffArtifact = {
  type: "diff"
  sessionID: string
  file: string
  additions: number
  deletions: number
}

export type FileArtifact = {
  type: "file"
  sessionID: string
  file: string
}

export type ScreenshotArtifact = {
  type: "screenshot"
  sessionID: string
  url: string
  note?: string
  rect?: ArtifactRect
  path?: string
  thumbnail?: string
}

export type NoteArtifact = {
  type: "note"
  sessionID: string
  text: string
  file?: string
}

export type Artifact = DiffArtifact | FileArtifact | ScreenshotArtifact | NoteArtifact
export type ArtifactInput = FileArtifact | ScreenshotArtifact | NoteArtifact
export type StoredArtifact = ArtifactInput & { id: string; created: number }

export type ArtifactGroup = {
  sessionID: string
  title: string
  directory: string
  updated: number
  artifacts: Artifact[]
}

export type ArtifactFilter = "all" | "changed" | "screenshots" | "notes"

const MAX_DIFF_GROUPS = 20
const MAX_STORED = 100
const FILTER_STORAGE_KEY = "opencode.sidebar-artifacts.filter"
const ARTIFACT_STORAGE_PREFIX = "opencode.sidebar-artifacts."

export function artifactSessionHref(slug: string, sessionID: string, file: string) {
  return `/${slug}/session/${sessionID}?file=${encodeURIComponent(file)}`
}

// New-layout target: the session route (server + ID) plus `?file=` for file
// artifacts, which the session page turns into a focused review diff.
export function artifactTargetHref(sessionPath: string, artifact: Artifact) {
  if (artifact.type === "diff" || artifact.type === "file") return `${sessionPath}?file=${encodeURIComponent(artifact.file)}`
  return sessionPath
}

export function artifactMatchesFilter(artifact: Artifact, filter: ArtifactFilter) {
  if (filter === "changed") return artifact.type === "diff" || artifact.type === "file"
  if (filter === "screenshots") return artifact.type === "screenshot"
  if (filter === "notes") return artifact.type === "note"
  return true
}

export function filterArtifactGroups(groups: ArtifactGroup[], filter: ArtifactFilter): ArtifactGroup[] {
  if (filter === "all") return groups
  return groups
    .map((group) => ({ ...group, artifacts: group.artifacts.filter((artifact) => artifactMatchesFilter(artifact, filter)) }))
    .filter((group) => group.artifacts.length > 0)
}

export function groupSessionArtifacts(
  store: SessionDiffData,
  activeProjectDirectory: string,
  stored: StoredArtifact[] = [],
): ArtifactGroup[] {
  const key = pathKey(activeProjectDirectory)
  if (!key) return []
  const visible = new Map(
    (store.session ?? [])
      .filter((session) => pathKey(session.directory) === key && !session.parentID && !session.time?.archived)
      .map((session) => [session.id, session] as const),
  )
  if (visible.size === 0) return []
  const order = (a: ArtifactGroup, b: ArtifactGroup) => compareSessionTime(visible.get(a.sessionID)!, visible.get(b.sessionID)!)
  const groupOf = (sessionID: string): ArtifactGroup => {
    const session = visible.get(sessionID)!
    return {
      sessionID,
      title: session.title,
      directory: session.directory,
      updated: session.time.updated ?? session.time.created,
      artifacts: [],
    }
  }
  const diffs = Object.entries(store.session_diff)
    .filter(([sessionID, files]) => files.length > 0 && visible.has(sessionID))
    .map(([sessionID, files]) => ({
      ...groupOf(sessionID),
      artifacts: files.map(
        (item): DiffArtifact => ({ type: "diff", sessionID, file: item.file, additions: item.additions, deletions: item.deletions }),
      ),
    }))
    .sort(order)
    .slice(0, MAX_DIFF_GROUPS)
  const storedGroups = stored
    .filter((artifact) => visible.has(artifact.sessionID))
    .reduce((map, artifact) => map.set(artifact.sessionID, [...(map.get(artifact.sessionID) ?? []), artifact]), new Map<string, StoredArtifact[]>())
  const merged = diffs.map((group) => ({ ...group, artifacts: [...group.artifacts, ...(storedGroups.get(group.sessionID) ?? [])] }))
  const extra = [...storedGroups.entries()]
    .filter(([sessionID]) => !merged.some((group) => group.sessionID === sessionID))
    .map(([sessionID, artifacts]) => ({ ...groupOf(sessionID), artifacts }))
  return [...merged, ...extra].sort(order)
}

export function loadArtifactFilter(): ArtifactFilter {
  if (typeof localStorage !== "object") return "all"
  const value = localStorage.getItem(FILTER_STORAGE_KEY)
  if (value === "changed" || value === "screenshots" || value === "notes") return value
  return "all"
}

export function saveArtifactFilter(filter: ArtifactFilter) {
  if (typeof localStorage !== "object") return
  localStorage.setItem(FILTER_STORAGE_KEY, filter)
}

export function loadStoredArtifacts(directory: string): StoredArtifact[] {
  if (typeof localStorage !== "object") return []
  return parseStored(localStorage.getItem(storageKey(directory)))
}

// Bumped on every storeArtifact write so reactive consumers (the sidebar) can
// re-read the non-reactive localStorage store without switching directories.
const [artifactVersion, setArtifactVersion] = createSignal(0)

export function artifactVersionSignal() {
  return artifactVersion()
}

export function storeArtifact(directory: string, artifact: ArtifactInput): StoredArtifact | undefined {
  if (typeof localStorage !== "object") return undefined
  const stored: StoredArtifact = {
    ...artifact,
    id: `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    created: Date.now(),
  }
  const next = [stored, ...loadStoredArtifacts(directory)].slice(0, MAX_STORED)
  localStorage.setItem(storageKey(directory), JSON.stringify(next))
  setArtifactVersion((version) => version + 1)
  return stored
}

function storageKey(directory: string) {
  return `${ARTIFACT_STORAGE_PREFIX}${pathKey(directory) ?? directory}`
}

function parseStored(value: string | null): StoredArtifact[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isStoredArtifact)
  } catch {
    return []
  }
}

function isStoredArtifact(input: unknown): input is StoredArtifact {
  if (typeof input !== "object" || input === null) return false
  const artifact = input as Record<string, unknown>
  if (typeof artifact.id !== "string" || typeof artifact.sessionID !== "string" || typeof artifact.created !== "number") return false
  if (artifact.type === "file") return typeof artifact.file === "string"
  if (artifact.type === "note") return typeof artifact.text === "string"
  if (artifact.type === "screenshot") return typeof artifact.url === "string"
  return false
}
