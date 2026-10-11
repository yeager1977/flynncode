import { app, globalShortcut } from "electron"
import { sendQuickEntry } from "./ipc"
import { getLogger } from "./logging"
import { getStore } from "./store"
import { QUICK_ENTRY_ENABLED_KEY } from "./store-keys"
import { getLastFocusedWindow } from "./windows"

export const QUICK_ENTRY_ACCELERATOR = "CommandOrControl+Shift+Space"

// The settings toggle defaults to enabled; only an explicit stored false
// disables the global shortcut.
export function getQuickEntryEnabled() {
  return getStore().get(QUICK_ENTRY_ENABLED_KEY) !== false
}

export function setQuickEntryEnabled(enabled: boolean) {
  getStore().set(QUICK_ENTRY_ENABLED_KEY, enabled)
  if (!enabled) {
    unregisterQuickEntryShortcut()
    return
  }
  registerQuickEntryShortcut()
}

export function registerQuickEntryShortcut() {
  if (!getQuickEntryEnabled()) return false
  const registered = globalShortcut.register(QUICK_ENTRY_ACCELERATOR, () => {
    const win = getLastFocusedWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    sendQuickEntry(win)
  })
  // register() returns false when another app owns the accelerator or the
  // desktop (e.g. Wayland without the portal) refuses global shortcuts.
  if (!registered) getLogger().warn("quick entry shortcut registration failed", { accelerator: QUICK_ENTRY_ACCELERATOR })
  app.once("will-quit", unregisterQuickEntryShortcut)
  return registered
}

export function unregisterQuickEntryShortcut() {
  globalShortcut.unregister(QUICK_ENTRY_ACCELERATOR)
}
