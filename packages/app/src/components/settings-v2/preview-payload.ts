import type { Config } from "@opencode-ai/sdk/v2/client"

// Raw preview server entry as written in opencode.json (tolerant tunnel).
export type PreviewRawServer = {
  name?: unknown
  command?: unknown
  args?: unknown
  cwd?: unknown
  port?: unknown
  url?: unknown
  autoPort?: unknown
  autoVerify?: unknown
}

export type PreviewForm = {
  servers: PreviewRawServer[]
  autoVerify: boolean
}

export function previewFromConfig(config: Config | undefined): PreviewForm {
  const raw = config?.preview as { servers?: unknown; autoVerify?: unknown } | undefined
  return {
    servers: Array.isArray(raw?.servers) ? (raw?.servers as PreviewRawServer[]) : [],
    autoVerify: raw?.autoVerify === false ? false : true,
  }
}

export function previewToConfig(form: PreviewForm): { preview?: { servers: PreviewRawServer[]; autoVerify: boolean } } {
  const servers = form.servers.filter((server) => typeof server.name === "string" && server.name !== "")
  return { preview: { servers, autoVerify: form.autoVerify } }
}