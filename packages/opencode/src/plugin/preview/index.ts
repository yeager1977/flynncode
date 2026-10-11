import { tool } from "@flynncode/plugin"
import type { Hooks, PluginInput } from "@flynncode/plugin"
import { ServerAuth } from "@/server/auth"

const PREFIX = "[preview]"

// Tolerant shape of GET /preview/servers; only what verify_page reads.
type ServerState = {
  name: string
  state: "running" | "stopped" | "starting" | "failed"
  url?: string
  attach?: boolean
  autoVerify?: boolean
}

type VerifyData = {
  url: string
  httpStatus: number
  title?: string
  errorCount?: number
}

// Error body of the declared PreviewApiError contract.
type ErrorBody = { name: string; data: { message: string } }

export function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

// Model-facing copy: tool output is read by the model, not rendered as UI.
export function inertMessage(): string {
  return "No preview server is running. Start one from the review browser dropdown, or configure one under preview.servers in opencode.json."
}

export function resolveRunning(servers: ServerState[], name?: string): ServerState | { missing: string } | undefined {
  if (name) {
    const found = servers.find((server) => server.name === name)
    if (!found) return { missing: name }
    return found
  }
  // Prefer a running server; a starting one is the next-best report so the
  // model learns verify_page must wait instead of assuming nothing exists.
  return (
    servers.find((server) => server.state === "running") ??
    servers.find((server) => server.state === "starting")
  )
}

export function createPreviewTools(deps: {
  list: (directory: string) => Promise<ServerState[] | undefined>
  post: (path: string, directory: string, body: unknown) => Promise<unknown>
}): NonNullable<Hooks["tool"]> {
  return {
    verify_page: tool({
      description:
        "Verify the running preview server: fetch its URL and report the HTTP status, page title, and a heuristic count of error markers in the returned HTML. Inert unless a preview server is running.",
      args: {
        name: tool.schema
          .string()
          .optional()
          .describe("Preview server name from config preview.servers; defaults to the first running server"),
      },
      async execute(args, ctx) {
        const servers = await deps.list(ctx.directory)
        if (!servers || servers.length === 0) {
          return "No preview servers are configured. Add a preview.servers entry to opencode.json, then start it from the review browser."
        }
        const picked = resolveRunning(servers, args.name)
        if (picked && "missing" in picked) {
          return `Unknown preview server "${picked.missing}". Configured: ${servers.map((server) => server.name).join(", ")}`
        }
        if (!picked) return inertMessage()
        if (picked.state !== "running") {
          return `Preview server "${picked.name}" is ${picked.state}. Start it from the review browser dropdown first.`
        }
        if (!picked.url || !isHttpUrl(picked.url)) return inertMessage()
        const result = await deps.post("/preview/servers/verify", ctx.directory, picked.name ? { name: picked.name } : {})
        if (!result || typeof result !== "object" || !("url" in result)) {
          return `Preview server "${picked.name}" did not respond; it may have stopped or crashed since the last check.`
        }
        const data = result as VerifyData
        const lines = [
          `URL: ${data.url}`,
          `HTTP status: ${data.httpStatus}`,
          data.title ? `Title: ${data.title}` : "Title: (none)",
          `Error markers: ${data.errorCount ?? 0}`,
        ]
        if (data.httpStatus >= 400) lines.push("The page returned an HTTP error; check the preview server output.")
        return lines.join("\n")
      },
    }),
  }
}

export const PreviewPlugin = async (input: PluginInput): Promise<Hooks> => {
  const directory = input.directory
  const base = input.serverUrl

  const request = async (path: string, method: "GET" | "POST", body: unknown) => {
    const url = new URL(path, base ?? "http://localhost:4096")
    url.searchParams.set("directory", directory)
    const response = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": directory,
        ...ServerAuth.headers(),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    })
    if (!response.ok) {
      const detail = (await response.json().catch(() => undefined)) as ErrorBody | undefined
      console.warn(`${PREFIX} ${path} failed (${response.status}): ${detail?.data?.message ?? response.statusText}`)
      return undefined
    }
    return (await response.json()) as unknown
  }

  return {
    tool: createPreviewTools({
      list: async (dir) => {
        if (dir !== directory) return []
        const result = await request("/preview/servers", "GET", undefined)
        return Array.isArray(result) ? (result as ServerState[]) : []
      },
      post: (path, dir, body) => request(path, "POST", body) as Promise<unknown>,
    }),
  }
}

export default {
  id: "preview",
  server: PreviewPlugin,
}