import { app, globalShortcut } from "electron"
import { sendQuickEntry } from "./ipc"
import { getLastFocusedWindow } from "./windows"

export const QUICK_ENTRY_ACCELERATOR = "CommandOrControl+Shift+Space"

export function registerQuickEntryShortcut() {
  const registered = globalShortcut.register(QUICK_ENTRY_ACCELERATOR, () => {
    const win = getLastFocusedWindow()
    if (!win) return
    win.show()
    win.focus()
    sendQuickEntry(win)
  })
  app.once("will-quit", unregisterQuickEntryShortcut)
  return registered
}

export function unregisterQuickEntryShortcut() {
  globalShortcut.unregister(QUICK_ENTRY_ACCELERATOR)
}
