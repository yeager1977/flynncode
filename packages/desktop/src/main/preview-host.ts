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

export function previewViewForSession(win: BrowserWindow, session: Session | undefined) {
  if (!session) return undefined
  const children = win.contentView.children as unknown as Array<WebContentsView>
  return children.find((child) => child.webContents?.session === session)
}

export function previewViewFor(win: BrowserWindow): WebContentsView | undefined {
  return previewViewForSession(win, previewSession)
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

// Loopback-only navigation: a guest that redirects or client-navigates
// elsewhere tears the view down and the renderer falls back to the iframe.
// Subframe commits are checked too: a remote subframe document is also too
// late to trust. (In-guest fetch of remote URLs stays a documented limitation.)
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
  view.webContents.on("did-frame-navigate", (event, url, _httpResponseCode, isMainFrame) => {
    // Informational event (not preventable): a non-loopback subframe commit is
    // treated like a main-frame escape — the view is already too late to trust.
    if (isMainFrame || isHostable(url)) return
    detachView(win)
    notifyTeardown(win)
  })
  // window.open / target=_blank must never spawn a window outside this guest's
  // loopback guard: denying outright is the least privilege for a pane tier
  // that has no use for popups (the app renderer's own external-url policy
  // does not apply to this untrusted guest).
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
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
  // A fresh guest must never inherit a stale renderer-hide from a previous
  // marking session: the flag only has meaning for the live view it hid.
  hiddenByRenderer.delete(win)
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, partition: "preview" },
  })
  win.contentView.addChildView(view)
  // The guest is created hidden and without bounds: a slow-loading loopback
  // page must not composite over chat, sidebar, or controls, and must not
  // receive whole-window input. It becomes visible only when the renderer's
  // setBounds claims the pane geometry it owns.
  view.setVisible(false)
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
  const view = previewViewFor(win)
  if (!view) return
  view.setBounds(rect)
  // First valid ownership bounds reveal the view (I10: the guest starts
  // hidden); a zero-size rect keeps it hidden. A renderer-hidden view (marking
  // freeze keeps the bounds intact, so resizes during marking stay in sync)
  // must not be revealed by a bounds refresh.
  if (hiddenByRenderer.get(win) === true) return
  view.setVisible(rect.width > 0 && rect.height > 0)
}

// Hides the guest's compositing and input without collapsing its bounds, so
// the coordinate space of the marking overlay keeps matching the live view.
const hiddenByRenderer = new WeakMap<BrowserWindow, boolean>()

export function setViewVisible(win: BrowserWindow, visible: boolean) {
  const view = previewViewFor(win)
  if (!view) return
  hiddenByRenderer.set(win, !visible)
  view.setVisible(visible)
}

export function detachView(win: BrowserWindow) {
  // The renderer-hide flag is meaningless without the view it hid; a detached
  // view must not leak a stale hide into the next attach.
  hiddenByRenderer.delete(win)
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
