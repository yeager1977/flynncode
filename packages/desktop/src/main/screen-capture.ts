type CaptureSource = {
  name?: string
  thumbnail?: { toDataURL: () => string }
}

export type GetSources = (options: { types: ["screen"]; thumbnailSize: { width: number; height: number } }) => Promise<
  CaptureSource[]
>

const CAPTURE_TIMEOUT_MS = 5_000
const THUMBNAIL_SIZE = { width: 1920, height: 1920 }
const THUMBNAIL_PREFIX = "data:image/"

// Injectable default keeps the `electron` import out of unit tests; it only
// loads when the real capture runs.
const electronGetSources: GetSources = async (options) => {
  const { desktopCapturer } = await import("electron")
  return desktopCapturer.getSources(options)
}

export async function capturePrimaryScreen(deps: { getSources: GetSources; timeoutMs?: number }): Promise<
  { dataUrl: string } | null
> {
  const timeoutMs = deps.timeoutMs ?? CAPTURE_TIMEOUT_MS
  // Screenshot capture must never throw into callers: a hung or denied
  // screenshooter (e.g. Wayland without the portal) collapses to a timeout,
  // and sources without a usable image are skipped.
  const sources = await Promise.race([
    deps.getSources({ types: ["screen"], thumbnailSize: THUMBNAIL_SIZE }).catch(() => [] as CaptureSource[]),
    new Promise<CaptureSource[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
  ])
  for (const source of sources) {
    const thumbnail = source.thumbnail
    if (!thumbnail) continue
    const dataUrl = thumbnail.toDataURL()
    if (dataUrl.startsWith(THUMBNAIL_PREFIX)) return { dataUrl }
  }
  return null
}

export function captureScreen() {
  return capturePrimaryScreen({ getSources: electronGetSources })
}