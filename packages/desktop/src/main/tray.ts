import { app, Menu, nativeImage, Tray } from "electron"
import { nativeT } from "./native-translations"
import { setTrayActive, trayActive } from "./tray-state"
import { showMainWindows, trayIconPath } from "./windows"

// The tray icon keeps the app alive when the window is closed. The sidecar
// server is a separate process, so sessions keep running while the UI is
// hidden, and the tray brings the UI back.
let tray: Tray | undefined

export function createTray() {
  if (tray) return tray
  const icon = nativeImage.createFromPath(trayIconPath())
  if (icon.isEmpty()) return undefined
  const size = process.platform === "darwin" ? 22 : 16
  try {
    tray = new Tray(icon.resize({ width: size, height: size }))
  } catch {
    // No status notifier (headless Linux, missing libappindicator): keep the
    // app's close-to-quit behaviour.
    return undefined
  }
  setTrayActive(true)
  tray.setToolTip(nativeT("desktop.menu.app"))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: nativeT("desktop.menu.app"), click: () => showMainWindows() },
      { type: "separator" },
      { role: "quit" },
    ]),
  )
  // macOS opens the context menu on click; elsewhere the click brings the UI back.
  if (process.platform !== "darwin") tray.on("click", () => showMainWindows())
  return tray
}

export function destroyTray() {
  tray?.destroy()
  tray = undefined
  setTrayActive(false)
}

export { trayActive }
