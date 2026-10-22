// Tray state without Electron imports, so the window layer can ask whether a
// close should hide the window without pulling in the tray module (which
// depends on the window layer in turn).
let active = false

export function setTrayActive(value: boolean) {
  active = value
}

export function trayActive() {
  return active
}

/**
 * Whether closing a window should hide it instead of quitting the app.
 * Without a working tray there would be no way back to the UI, so the app
 * keeps its current behaviour of quitting.
 */
export function shouldHideOnClose(input: { trayActive: boolean; quitting: boolean }) {
  return input.trayActive && !input.quitting
}
