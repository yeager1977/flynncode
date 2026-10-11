export * as ConfigPreview from "./preview"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

const PREFIX = "[preview]"

export type ServerSettings = {
  name: string
  command?: string
  args?: string[]
  cwd?: string
  port?: number
  url?: string
  autoPort?: boolean
  autoVerify?: boolean
}

export type Settings = {
  servers: ServerSettings[]
  autoVerify: boolean
  nativeHost: boolean
}

const URL_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/

const DEFAULTS = {
  autoVerify: true,
  nativeHost: false,
} as const

// config.preview is tolerant like model_router: the schema tunnel keeps
// unknown values and validation happens here, so a single invalid server
// entry is skipped with a logged warning instead of failing config load.
export function settings(config: ConfigV1.Info | undefined): { value: Settings; warnings: string[] } {
  const warnings: string[] = []
  const raw = isRecord(config?.preview) ? config?.preview : {}
  const autoVerify =
    typeof raw.autoVerify === "boolean" ? raw.autoVerify : DEFAULTS.autoVerify
  const nativeHost = typeof raw.nativeHost === "boolean" ? raw.nativeHost : DEFAULTS.nativeHost

  const servers: ServerSettings[] = []
  const seen = new Set<string>()
  if (!Array.isArray(raw.servers)) {
    if (raw.servers !== undefined) warnings.push("preview.servers must be an array; preview servers ignored")
    return { value: { servers, autoVerify, nativeHost }, warnings }
  }

  for (const [index, entry] of raw.servers.entries()) {
    if (!isRecord(entry)) {
      warnings.push(`preview.servers[${index}] ignored: entry is not an object`)
      continue
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : ""
    if (!name) {
      warnings.push(`preview.servers[${index}] ignored: missing name`)
      continue
    }
    if (seen.has(name)) {
      warnings.push(`preview.servers[${index}] ignored: duplicate name "${name}"`)
      continue
    }
    const command = typeof entry.command === "string" && entry.command.trim() !== "" ? entry.command.trim() : undefined
    const args =
      Array.isArray(entry.args) && entry.args.every((item) => typeof item === "string")
        ? (entry.args as string[])
        : undefined
    if (args && !command) warnings.push(`preview.servers["${name}"]: args ignored without command`)
    const cwd = typeof entry.cwd === "string" && entry.cwd.trim() !== "" ? entry.cwd : undefined
    const port = typeof entry.port === "number" && Number.isInteger(entry.port) && entry.port >= 0 ? entry.port : undefined
    const url = typeof entry.url === "string" && entry.url.trim() !== "" ? entry.url.trim() : undefined
    const prefix = `${PREFIX} preview.servers["${name}"] ignored:`
    const parsed = url === undefined ? undefined : parseUrl(warnings, name, url, port, prefix)
    const autoPort = typeof entry.autoPort === "boolean" ? entry.autoPort : undefined
    const autoVerifyEntry = typeof entry.autoVerify === "boolean" ? entry.autoVerify : undefined

    if (parsed === undefined && url !== undefined) continue
    if (command === undefined && parsed === undefined) {
      warnings.push(`preview.servers["${name}"] ignored: needs "command" (managed) or "url" (attach-only)`)
      continue
    }
    if (autoPort !== undefined && parsed !== undefined && command === undefined) {
      warnings.push(`preview.servers["${name}"]: autoPort ignored for attach-only server`)
    }

    seen.add(name)
    servers.push({
      name,
      ...(command ? { command } : {}),
      ...(args && command ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(parsed ? { url: parsed.toString() } : {}),
      ...(autoPort !== undefined ? { autoPort } : {}),
      ...(autoVerifyEntry !== undefined ? { autoVerify: autoVerifyEntry } : {}),
    })
  }

  return { value: { servers, autoVerify, nativeHost }, warnings }
}

// Attach URLs: http/https only, no userinfo; a localhost URL must be
// origin-only with an explicit port that matches a declared `port`, so the
// review pane always loads exactly the served app.
function parseUrl(
  warnings: string[],
  name: string,
  value: string,
  port: number | undefined,
  prefix: string,
): URL | undefined {
  const parsed = tryUrl(value)
  if (!parsed) {
    warnings.push(`${prefix} url "${value}" is not a valid URL`)
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    warnings.push(`${prefix} url must use http or https (${value})`)
    return undefined
  }
  if (parsed.username || parsed.password) {
    warnings.push(`${prefix} url must not embed user credentials (userinfo)`)
    return undefined
  }
  const local = URL_LOCAL.test(parsed.hostname)
  if (local) {
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      warnings.push(
        `${prefix} url for localhost "${parsed.hostname}" must be origin-only (${parsed.origin}); the review pane loads the origin`,
      )
      return undefined
    }
    if (!parsed.port) {
      warnings.push(`${prefix} url for localhost "${parsed.hostname}" must include an explicit port`)
      return undefined
    }
    if (port !== undefined && Number(parsed.port) !== port) {
      warnings.push(`${prefix} url port ${parsed.port} does not match the declared port ${port}`)
      return undefined
    }
  }
  return parsed
}

function tryUrl(value: string) {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const defaults = DEFAULTS
