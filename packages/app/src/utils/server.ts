import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

function attachmentSource(value: object) {
  const mention = "mention" in value ? value.mention : "source" in value ? value.source : undefined
  if (!mention || typeof mention !== "object") return
  if (!("start" in mention) || !("end" in mention) || !("text" in mention)) return
  if (typeof mention.start !== "number" || typeof mention.end !== "number" || typeof mention.text !== "string") return
  return { start: mention.start, end: mention.end, text: mention.text }
}

function promptFile(value: unknown) {
  if (!value || typeof value !== "object" || !("uri" in value) || typeof value.uri !== "string") return []
  const source = attachmentSource(value)
  return [
    {
      uri: value.uri,
      ...("name" in value && typeof value.name === "string" ? { name: value.name } : {}),
      ...("description" in value && typeof value.description === "string" ? { description: value.description } : {}),
      ...(source ? { source } : {}),
    },
  ]
}

function promptAgent(value: unknown) {
  if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string") return []
  const source = attachmentSource(value)
  return [{ name: value.name, ...(source ? { source } : {}) }]
}

function nestedPrompt(value: unknown) {
  if (!value || typeof value !== "object" || "prompt" in value) return
  if (!("text" in value) || typeof value.text !== "string") return
  const files = "files" in value && Array.isArray(value.files) ? value.files.flatMap(promptFile) : []
  const agents = "agents" in value && Array.isArray(value.agents) ? value.agents.flatMap(promptAgent) : []
  return {
    ...("id" in value ? { id: value.id } : {}),
    ...("delivery" in value ? { delivery: value.delivery } : {}),
    ...("resume" in value ? { resume: value.resume } : {}),
    prompt: {
      text: value.text,
      ...(files.length > 0 ? { files } : {}),
      ...(agents.length > 0 ? { agents } : {}),
    },
  }
}

function promptFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const raw = typeof init?.body === "string" ? init.body : undefined
    if (method === "POST" && /\/api\/session\/[^/]+\/prompt$/.test(new URL(url).pathname) && raw) {
      const prompt = nestedPrompt(JSON.parse(raw) as unknown)
      if (prompt) {
        const headers = new Headers(init?.headers)
        headers.set("content-type", "application/json")
        return fetch(url, { ...init, method, headers, body: JSON.stringify(prompt) })
      }
    }
    return fetch(input, init)
  }
  wrapped.preconnect = fetch.preconnect
  return wrapped
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OpenCodeClient {
  return OpenCode.make({
    baseUrl: input.server.url,
    fetch: promptFetch(input.fetch ?? globalThis.fetch),
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
  })
}

export type ServerApi = OpenCodeClient
