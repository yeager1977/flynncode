import type { ServerConnection } from "@/context/server"

export type SessionFolders = {
  primary: string
  extras: string[]
}

export type FoldersConnection = {
  url: string
  username?: string
  password?: string
  fetchFn?: typeof fetch
}

function basicAuth(username?: string, password?: string): string | undefined {
  if (!password) return undefined
  return `Basic ${btoa(`${username || "opencode"}:${password}`)}`
}

// Multifold: the app pins the vendored v1-compatible API client, which has
// no folders routes, so folder reads/writes go through these typed fetch
// helpers. Extras use the V2 session folders route; switching primary uses
// the instance folders route, which reboots the instance and rebinds the
// session directory.
export function foldersConnection(
  conn: ServerConnection.Any | undefined,
  fetchFn?: typeof fetch,
): FoldersConnection | undefined {
  if (!conn || typeof conn !== "object") return undefined
  if ("http" in conn && conn.http) return { ...conn.http, fetchFn }
  if ("url" in conn && typeof (conn as { url?: unknown }).url === "string")
    return { ...(conn as { url: string; username?: string; password?: string }), fetchFn }
  return undefined
}

function requestHeaders(conn: FoldersConnection, directory?: string): Record<string, string> {
  const auth = basicAuth(conn.username, conn.password)
  return {
    "content-type": "application/json",
    ...(directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {}),
    ...(auth ? { Authorization: auth } : {}),
  }
}

async function readFolders(response: Response): Promise<SessionFolders | undefined> {
  if (!response.ok) return undefined
  const json = (await response.json()) as unknown
  if (!json || typeof json !== "object") return undefined
  const record = json as Record<string, unknown>
  if (typeof record.primary !== "string" || !Array.isArray(record.extras)) return undefined
  return { primary: record.primary, extras: record.extras.filter((item): item is string => typeof item === "string") }
}

export async function getSessionFolders(
  conn: FoldersConnection,
  sessionID: string,
): Promise<SessionFolders | undefined> {
  const doFetch = conn.fetchFn ?? fetch
  const response = await doFetch(`${conn.url}/api/session/${encodeURIComponent(sessionID)}/folders`, {
    headers: requestHeaders(conn),
  }).catch(() => undefined)
  if (!response) return undefined
  return readFolders(response)
}

export async function setSessionExtras(
  conn: FoldersConnection,
  sessionID: string,
  extras: readonly string[],
): Promise<SessionFolders | undefined> {
  const doFetch = conn.fetchFn ?? fetch
  const response = await doFetch(`${conn.url}/api/session/${encodeURIComponent(sessionID)}/folders`, {
    method: "POST",
    headers: requestHeaders(conn),
    body: JSON.stringify({ extras: [...extras] }),
  }).catch(() => undefined)
  if (!response) return undefined
  return readFolders(response)
}

export async function setSessionPrimary(
  conn: FoldersConnection,
  sessionID: string,
  directory: string,
  primary: string,
): Promise<SessionFolders | undefined> {
  const doFetch = conn.fetchFn ?? fetch
  const response = await doFetch(`${conn.url}/session/${encodeURIComponent(sessionID)}/folders`, {
    method: "POST",
    headers: requestHeaders(conn, directory),
    body: JSON.stringify({ primary }),
  }).catch(() => undefined)
  if (!response) return undefined
  return readFolders(response)
}
