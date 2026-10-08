import type { BrowserWindow, WebContentsView } from "electron"

export function clampPanePoint(x: number, y: number, bounds: { width: number; height: number }): { x: number; y: number } {
  return { x: Math.min(Math.max(0, x), bounds.width), y: Math.min(Math.max(0, y), bounds.height) }
}

export function isComputerUseTargetAllowed(appID: string, allowedApps: string[]): boolean {
  return allowedApps.includes(appID)
}

function paneFor(win: BrowserWindow): WebContentsView | undefined {
  const children = win.contentView.children as unknown as Array<WebContentsView>
  return children.find((child) => typeof child.webContents?.sendInputEvent === "function")
}

export function clickPane(win: BrowserWindow, x: number, y: number) {
  const pane = paneFor(win)
  if (pane === undefined) return
  const size = pane.getBounds()
  const point = clampPanePoint(x, y, { width: size.width, height: size.height })
  pane.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 })
  pane.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 })
}

export function typePane(win: BrowserWindow, text: string) {
  const pane = paneFor(win)
  if (pane === undefined) return
  for (const char of text) pane.webContents.sendInputEvent({ type: "char", keyCode: char })
}

export function keypressPane(win: BrowserWindow, key: string) {
  const pane = paneFor(win)
  if (pane === undefined) return
  pane.webContents.sendInputEvent({ type: "keyDown", keyCode: key })
  pane.webContents.sendInputEvent({ type: "keyUp", keyCode: key })
}

export function scrollPane(win: BrowserWindow, deltaX: number, deltaY: number) {
  const pane = paneFor(win)
  if (pane === undefined) return
  pane.webContents.sendInputEvent({ type: "mouseWheel", x: 0, y: 0, deltaX, deltaY })
}
