import type { BrowserWindow, Session, WebContentsView } from "electron"

export type PreviewRect = { x: number; y: number; width: number; height: number }

export type PreviewElement = {
  tag: string
  id?: string
  classes?: string
  text?: string
  rect: PreviewRect
}

const loopbackHost = (hostname: string) => {
  const host = hostname.toLowerCase()
  // WHATWG URL keeps brackets on IPv6 hostnames.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  // Strictly loopback: the native view has full network privileges, so mDNS
  // names like *.local that can resolve to LAN hosts are refused here even
  // though the sandboxed iframe gate tolerates more.
  if (bare === "localhost" || bare.endsWith(".localhost")) return true
  if (bare === "::1") return true
  return /^127\.\d+\.\d+\.\d+$/.test(bare)
}

// Only loopback http(s) targets can be hosted natively; mirrors the iframe
// gate in the renderer (browser-pane.ts isLocalPreviewUrl). Every IPC handler
// re-validates this as defense in depth.
export function isHostable(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return loopbackHost(url.hostname)
}

const RECT_LIMIT = 1_000_000

const clampRectValue = (value: number) => Math.min(Math.max(0, value), RECT_LIMIT)

// The renderer measures in CSS pixels; view bounds and page points are DIPs,
// which differ by the renderer zoom factor (same correction as capturePage
// rects in ipc.ts). Zero width/height is allowed so the view can be hidden.
export function parsePreviewRect(input: unknown, zoom: number): PreviewRect | undefined {
  if (!input || typeof input !== "object") return undefined
  const rect = input as Record<string, unknown>
  const values = [rect.x, rect.y, rect.width, rect.height]
  if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value))) return undefined
  const [x, y, width, height] = values.map((value) => clampRectValue(Math.round(value * zoom)))
  return { x, y, width, height }
}

const bounded = (value: unknown, limit: number) => {
  if (typeof value !== "string") return undefined
  const cleaned = value.trim()
  if (!cleaned) return undefined
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned
}

// Clamps the inspect-script payload so a hostile page cannot inject unbounded
// strings or off-viewport geometry into annotation metadata.
export function sanitizeElement(input: unknown): PreviewElement | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const tag = bounded(raw.tag, 64)
  const rect = parsePreviewRect(raw.rect, 1)
  if (!tag || !rect) return undefined
  const id = bounded(raw.id, 200)
  const classes = bounded(raw.classes, 200)
  const text = bounded(raw.text, 200)
  return { tag, rect, ...(id ? { id } : {}), ...(classes ? { classes } : {}), ...(text ? { text } : {}) }
}

// Dynamic import keeps pure helpers loadable under node-only bun tests.
const electron = () => import("electron")

// The preview view is identified by its partition session: Electron hands out
// the same session object per partition name and no other view uses this one.
let previewSession: Session | undefined

function previewViewFor(win: BrowserWindow): WebContentsView | undefined {
  if (!previewSession) return undefined
  const children = win.contentView.children as unknown as Array<WebContentsView>
  return children.find((child) => child.webContents?.session === previewSession)
}

// Stored so detachView can remove it; WeakMap cleans up when the window does.
const closedHandlers = new WeakMap<BrowserWindow, () => void>()

const ownerHooked = new WeakSet<BrowserWindow>()

// Owner lifecycle: a crashed or reloaded host renderer must never leave a
// stale guest compositing; the reload path re-attaches fresh.
function hookOwnerLifecycle(win: BrowserWindow) {
  if (ownerHooked.has(win)) return
  ownerHooked.add(win)
  win.webContents.on("render-process-gone", () => detachView(win))
  win.webContents.on("did-navigate", () => detachView(win))
}

// The preview view is trusted with loopback-only main-frame navigation: a
// guest that redirects or client-navigates elsewhere tears the view down and
// the renderer falls back to the iframe.
function guardGuestNavigation(win: BrowserWindow, view: WebContentsView) {
  view.webContents.on("will-navigate", (event, url) => {
    if (isHostable(url)) return
    event.preventDefault()
    detachView(win)
    notifyTeardown(win)
  })
  // Backstop for server redirects that skip will-navigate: once the guest
  // landed anywhere non-loopback, the view is already too late to trust.
  view.webContents.on("did-navigate", (_event, url) => {
    if (isHostable(url)) return
    detachView(win)
    notifyTeardown(win)
  })
}

function notifyTeardown(win: BrowserWindow) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send("preview-host-teardown")
}

export async function attachView(win: BrowserWindow, url: string) {
  if (!isHostable(url)) throw new Error("preview-host: only local http(s) URLs can be hosted")
  const { session, WebContentsView } = await electron()
  detachView(win)
  hookOwnerLifecycle(win)
  previewSession = session.fromPartition("preview")
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, partition: "preview" },
  })
  win.contentView.addChildView(view)
  const content = win.getContentBounds()
  view.setBounds({ x: 0, y: 0, width: content.width, height: content.height })
  // Closing the window removes the view with its content view, but the guest
  // webContents needs an explicit close so it never outlives the window.
  const onClosed = () => {
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
  win.once("closed", onClosed)
  closedHandlers.set(win, onClosed)
  guardGuestNavigation(win, view)
  await view.webContents.loadURL(url)
}

export function setViewBounds(win: BrowserWindow, rect: PreviewRect) {
  previewViewFor(win)?.setBounds(rect)
}

export function detachView(win: BrowserWindow) {
  const onClosed = closedHandlers.get(win)
  if (onClosed) {
    win.removeListener("closed", onClosed)
    closedHandlers.delete(win)
  }
  const view = previewViewFor(win)
  if (!view) return
  win.contentView.removeChildView(view)
  if (!view.webContents.isDestroyed()) view.webContents.close()
}

export async function captureView(win: BrowserWindow): Promise<string | undefined> {
  const view = previewViewFor(win)
  if (!view) return undefined
  const image = await view.webContents.capturePage()
  if (image.isEmpty()) return undefined
  return image.toDataURL()
}

// Read-only collect script: elementFromPoint + getComputedStyle-free reads of
// tag/class/text/rect. No mutation, no listeners installed, so the inspected
// page never changes behavior. The point is serialized, not interpolated as
// bare numbers, so the script cannot be shaped by unexpected inputs.
const inspectScript = (center?: { x: number; y: number }) =>
  `(() => {
  const point = ${center ? JSON.stringify(center) : "({ x: window.innerWidth / 2, y: window.innerHeight / 2 })"}
  const el = document.elementFromPoint(point.x, point.y)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  return {
    tag: el.tagName,
    id: typeof el.id === "string" ? el.id : "",
    classes: typeof el.className === "string" ? el.className : Array.from(el.classList ?? []).join(" "),
    text: typeof el.textContent === "string" ? el.textContent : "",
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  }
})()`

export async function inspectView(win: BrowserWindow, rect?: PreviewRect): Promise<PreviewElement | null> {
  const view = previewViewFor(win)
  if (!view) return null
  // An explicit rect inspects the element under its center; without one the
  // viewport center is inspected. Rects arrive as DIPs and the guest page runs
  // at zoom 1, so DIPs are the guest page's CSS pixels.
  const center = rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : undefined
  const raw = await view.webContents.executeJavaScript(inspectScript(center), false)
  return sanitizeElement(raw) ?? null
}
