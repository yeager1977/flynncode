import type { BrowserWindow } from "electron"
import { captureView, previewViewFor } from "./preview-host"

export type ComputerUseActuation =
  | { status: "performed" }
  | { status: "refused"; reason: string }
  | { status: "unavailable" }

export type ComputerUseScreenshot =
  | { status: "performed"; screenshot: string }
  | { status: "refused"; reason: string }
  | { status: "unavailable" }

export type ExecutionClaims = Map<string, number>

export const COMPUTER_USE_CLAIM_TTL = 30_000

// Exactly-once actuation: every desktop window receives the same broadcast
// request, so the main process adjudicates a single winner per requestID. The
// check-and-set runs inside one IPC handler call (the main process runs
// handlers serially), so the atomicity is real. Entries expire and are pruned
// lazily so the map cannot grow with stale request ids.
export function claimComputerUseExecution(
  claims: ExecutionClaims,
  requestID: string,
  now: number,
  ttl = COMPUTER_USE_CLAIM_TTL,
): boolean {
  for (const [id, time] of claims) {
    if (now - time > ttl) claims.delete(id)
  }
  if (claims.has(requestID)) return false
  claims.set(requestID, now)
  return true
}

export function clampPanePoint(x: number, y: number, bounds: { width: number; height: number }): { x: number; y: number } {
  return { x: Math.min(Math.max(0, x), bounds.width), y: Math.min(Math.max(0, y), bounds.height) }
}

export function isComputerUseTargetAllowed(appID: string, allowedApps: string[]): boolean {
  return allowedApps.includes(appID)
}

// The pane is the preview view itself, matched by its session partition, so no
// other child view can ever be driven by computer use (pane identity shared
// with preview-host).
function paneFor(win: BrowserWindow) {
  return previewViewFor(win)
}

export function clickPane(win: BrowserWindow, x: number, y: number): ComputerUseActuation {
  const pane = paneFor(win)
  if (pane === undefined) return { status: "unavailable" }
  const size = pane.getBounds()
  const point = clampPanePoint(x, y, { width: size.width, height: size.height })
  pane.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 })
  pane.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 })
  return { status: "performed" }
}

export function typePane(win: BrowserWindow, text: string): ComputerUseActuation {
  const pane = paneFor(win)
  if (pane === undefined) return { status: "unavailable" }
  for (const char of text) pane.webContents.sendInputEvent({ type: "char", keyCode: char })
  return { status: "performed" }
}

export function keypressPane(win: BrowserWindow, key: string): ComputerUseActuation {
  const pane = paneFor(win)
  if (pane === undefined) return { status: "unavailable" }
  pane.webContents.sendInputEvent({ type: "keyDown", keyCode: key })
  pane.webContents.sendInputEvent({ type: "keyUp", keyCode: key })
  return { status: "performed" }
}

export function scrollPane(win: BrowserWindow, deltaX: number, deltaY: number): ComputerUseActuation {
  const pane = paneFor(win)
  if (pane === undefined) return { status: "unavailable" }
  pane.webContents.sendInputEvent({ type: "mouseWheel", x: 0, y: 0, deltaX, deltaY })
  return { status: "performed" }
}

// Screenshots come from the actual preview view (capturePage on the guest), not
// app:capturePage: a composited native view is not part of the renderer capture.
export async function screenshotPane(win: BrowserWindow): Promise<ComputerUseScreenshot> {
  const captured = await captureView(win)
  if (captured === undefined) return { status: "unavailable" }
  return { status: "performed", screenshot: captured }
}