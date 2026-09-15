export type GatewayOptions = {
  host: string
  port: number
  upstream: string
  username: string
  password: string
}

export type ResolveResult = { ok: true; value: GatewayOptions } | { ok: false; reason: string }

const DEFAULT_HOST = "0.0.0.0"
const DEFAULT_PORT = 4097
const DEFAULT_UPSTREAM = "http://127.0.0.1:4096"
const DEFAULT_USERNAME = "opencode"

function readPort(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65535) return "invalid"
  return value
}

function normalizeUpstream(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    return url.origin + url.pathname.replace(/\/+$/, "")
  } catch {
    return
  }
}

export function resolveOptions(env: Record<string, string | undefined>): ResolveResult {
  const password = env.OPENCODE_SERVER_PASSWORD ?? ""
  if (!password) {
    return { ok: false, reason: "OPENCODE_SERVER_PASSWORD must be set and non-empty to start the mobile gateway" }
  }

  const port = readPort(env.OPENCODE_MOBILE_PORT)
  if (port === "invalid") return { ok: false, reason: `OPENCODE_MOBILE_PORT is not a valid port` }

  const upstream = normalizeUpstream(env.OPENCODE_MOBILE_UPSTREAM ?? DEFAULT_UPSTREAM)
  if (!upstream) return { ok: false, reason: "OPENCODE_MOBILE_UPSTREAM is not a valid http(s) URL" }

  return {
    ok: true,
    value: {
      host: env.OPENCODE_MOBILE_HOST ?? DEFAULT_HOST,
      port: port ?? DEFAULT_PORT,
      upstream,
      username: env.OPENCODE_SERVER_USERNAME ?? DEFAULT_USERNAME,
      password,
    },
  }
}

export function envAuthHeader(options: GatewayOptions): string {
  return `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`
}