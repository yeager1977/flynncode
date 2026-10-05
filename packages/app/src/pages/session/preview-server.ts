import type { PreviewServer } from "@opencode-ai/sdk/v2/client"

// Error body of the server's declared PreviewError contract.
type PreviewErrorBody = {
  name: string
  data?: { message?: string }
}

export type PreviewServerState = PreviewServer

// Tailwind-free state colors are expressed with the UI design tokens so the
// dot matches the surrounding review pane styling.
export function previewDotClass(state: PreviewServerState["state"]): string {
  switch (state) {
    case "running":
      return "bg-icon-success-base"
    case "starting":
      return "bg-icon-warning-base"
    case "failed":
      return "bg-icon-critical-base"
    default:
      return "bg-icon-weak-base"
  }
}

// Attach-only servers have no lifecycle commands beyond reloading their URL.
export function previewManaged(server: PreviewServerState): boolean {
  return server.attach !== true
}

// Extracts a diagnosable message from an SDK error thrown with throwOnError.
// Callers only get the translated generic label + the server's message text.
export function previewErrorDetail(error: unknown): string | undefined {
  const body = (error as { data?: unknown; body?: PreviewErrorBody })?.body
  if (body && typeof body === "object" && "data" in body) {
    const data = (body as PreviewErrorBody).data
    if (data?.message) return data.message
  }
  if (error instanceof Error && error.message) return error.message
  return undefined
}