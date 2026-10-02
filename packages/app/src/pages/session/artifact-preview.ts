export type ArtifactKind = "html" | "markdown" | "image"

export function artifactPreviewKind(path: string): ArtifactKind | undefined {
  const name = path.split(/[/\\]/).pop()?.toLowerCase() ?? ""
  const dot = name.lastIndexOf(".")
  const ext = dot >= 0 ? name.slice(dot + 1) : ""
  if (ext === "html" || ext === "htm") return "html"
  if (ext === "md" || ext === "markdown") return "markdown"
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || ext === "svg")
    return "image"
  return
}

export function artifactMime(path: string) {
  const kind = artifactPreviewKind(path)
  const name = path.split(/[/\\]/).pop()?.toLowerCase() ?? ""
  if (kind === "html") return "text/html"
  if (kind === "markdown") return "text/markdown"
  if (name.endsWith(".png")) return "image/png"
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg"
  if (name.endsWith(".gif")) return "image/gif"
  if (name.endsWith(".webp")) return "image/webp"
  if (name.endsWith(".svg")) return "image/svg+xml"
  return "application/octet-stream"
}

export function artifactText(content: string, encoding?: string) {
  if (encoding !== "base64") return content
  const bytes = Uint8Array.from(atob(content), (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
