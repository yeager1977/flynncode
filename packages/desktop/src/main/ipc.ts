import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { parseDesktopNativeBundle, type DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"

import type { FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import { parsePairInput, type MachineSync } from "./machine-sync"
import { parsePrefs } from "./sidecar-sync"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { setForceFocus } from "./debug"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import {
  getPinchZoomEnabled,
  getWindowID,
  openExternalURL,
  openLocalFileURL,
  setPinchZoomEnabled,
  setTitlebar,
  updateTitlebar,
} from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { createDesktopDraftStore } from "./draft-store"
import { nativeT } from "./native-translations"
import { registerPluginManager } from "./plugin-manager"
import type { VendorStatus } from "./vendor-keychain"
import { clickPane, isComputerUseTargetAllowed, keypressPane, scrollPane, typePane } from "./computer-use"
import { COMPUTER_USE_ALLOWED_APPS_KEY, MOBILE_PHONE_PASSWORD_KEY } from "./store-keys"

const MOBILE_GATEWAY_PORT = 4097
const MOBILE_GATEWAY_STATUS_URL = "http://127.0.0.1:4097/flynncode-mobile-status"

function stoppedMobileGatewayStatus() {
  return { running: false, port: MOBILE_GATEWAY_PORT, lanUrls: [], launcherUrls: [], tailnetUrls: [], tailnetLauncherUrls: [] }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

// The renderer measures in CSS pixels; capturePage expects DIPs, which differ
// by the page zoom factor.
function parseCaptureRect(input: unknown, zoom: number) {
  if (!input || typeof input !== "object") return
  const rect = input as Record<string, unknown>
  const values = [rect.x, rect.y, rect.width, rect.height]
  if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value))) return
  const [x, y, width, height] = values.map((value) => Math.round(value * zoom))
  if (width <= 0 || height <= 0) return
  return { x: Math.max(0, x), y: Math.max(0, y), width, height }
}

function readComputerUseAllowedApps(): string[] {
  try {
    const value = getStore().get(COMPUTER_USE_ALLOWED_APPS_KEY)
    if (isStringArray(value)) return value
    if (typeof value !== "string" || value === "") return []
    const parsed = JSON.parse(value) as unknown
    return isStringArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: nativeT("desktop.dialog.files"), extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  isFirstLaunchOnboardingPending: () => Promise<boolean> | boolean
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null> | string | null
  isOldLayoutEligible: () => Promise<boolean> | boolean
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  museAuthStatus: () => Promise<{ installed: boolean; loggedIn: boolean }>
  museAuthSync: () => Promise<{ ok: boolean; output: string; code?: "not-found" | "failed" }>
  vendorAuthStatus: () => Promise<VendorStatus>
  vendorAuthSignout: (vendor: string) => Promise<void>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  setNativeTranslations: (bundle: DesktopNativeBundle) => void
  machineSync: MachineSync
}

export function registerIpcHandlers(deps: Deps) {
  const drafts = createDesktopDraftStore(join(app.getPath("userData"), "drafts.sqlite"))
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)
  app.on("before-quit", () => drafts.flush())
  app.once("will-quit", () => drafts.close())
  app.on("browser-window-created", (_event, win) => win.on("session-end", () => drafts.flush()))

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("is-first-launch-onboarding-pending", () => deps.isFirstLaunchOnboardingPending())
  ipcMain.handle("finish-first-launch-onboarding", (_event: IpcMainInvokeEvent, createDefaultProject: boolean) =>
    deps.finishFirstLaunchOnboarding(createDefaultProject),
  )
  ipcMain.handle("is-old-layout-eligible", () => deps.isOldLayoutEligible())
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("muse-auth-status", () => deps.museAuthStatus())
  ipcMain.handle("muse-auth-sync", () => deps.museAuthSync())
  ipcMain.handle("vendor-auth-status", () => deps.vendorAuthStatus())
  ipcMain.handle("vendor-auth-signout", (_event: IpcMainInvokeEvent, vendor: string) => deps.vendorAuthSignout(vendor))
  ipcMain.handle("get-mobile-gateway-status", async () => {
    try {
      const response = await fetch(MOBILE_GATEWAY_STATUS_URL, {
        signal: AbortSignal.timeout(2000),
      })
      if (!response.ok) return stoppedMobileGatewayStatus()
      const data = (await response.json()) as { port?: unknown; lanUrls?: unknown; launcherUrls?: unknown; tailnetUrls?: unknown; tailnetLauncherUrls?: unknown }
      if (typeof data.port !== "number" || !isStringArray(data.lanUrls) || !isStringArray(data.launcherUrls)) {
        return stoppedMobileGatewayStatus()
      }
      const tailnetUrls = isStringArray(data.tailnetUrls) ? data.tailnetUrls : []
      const tailnetLauncherUrls = isStringArray(data.tailnetLauncherUrls) ? data.tailnetLauncherUrls : []
      return { running: true, port: data.port, lanUrls: data.lanUrls, launcherUrls: data.launcherUrls, tailnetUrls, tailnetLauncherUrls }
    } catch {
      return stoppedMobileGatewayStatus()
    }
  })
  ipcMain.handle("get-mobile-phone-password", () => {
    const value = getStore().get(MOBILE_PHONE_PASSWORD_KEY)
    return typeof value === "string" && value ? value : null
  })
  // The sidecar reads the phone password once at spawn, so a rotated value
  // only takes effect after the app restarts.
  ipcMain.handle("rotate-mobile-phone-password", () => {
    const next = randomUUID()
    getStore().set(MOBILE_PHONE_PASSWORD_KEY, next)
    return next
  })
  // Phone access and machine sync change the sidecar live; no restart needed.
  ipcMain.handle("get-phone-access", () => deps.machineSync.phoneAccess())
  ipcMain.handle("set-phone-access", (_event: IpcMainInvokeEvent, enabled: unknown) => {
    if (typeof enabled === "boolean") deps.machineSync.setPhoneAccess(enabled)
  })
  ipcMain.handle("machine-sync-status", () => deps.machineSync.status())
  ipcMain.handle("machine-sync-create-code", () => deps.machineSync.createPairingCode())
  ipcMain.handle("machine-sync-pair", (_event: IpcMainInvokeEvent, host: unknown, code: unknown, prefs: unknown) => {
    const input = parsePairInput(host, code)
    if (!input) return { ok: false, reason: "failed" }
    return deps.machineSync.pair({ ...input, prefs: prefs === "theirs" ? "theirs" : "keep" })
  })
  ipcMain.handle("machine-sync-unpair", () => deps.machineSync.unpair())
  ipcMain.handle("machine-sync-now", () => deps.machineSync.syncNow())
  ipcMain.handle("machine-sync-reload-config", () => deps.machineSync.reloadConfig())
  ipcMain.handle("machine-sync-set-paused", (_event: IpcMainInvokeEvent, paused: unknown) => {
    if (typeof paused === "boolean") deps.machineSync.setPaused(paused)
  })
  ipcMain.handle("machine-sync-push-prefs", (_event: IpcMainInvokeEvent, prefs: unknown) => {
    const parsed = parsePrefs(prefs)
    if (!parsed) return null
    return deps.machineSync.pushPrefs(parsed) ?? null
  })
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("app:capturePage", (event: IpcMainInvokeEvent, input: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return undefined
    // A rect that is present but malformed is refused rather than widened to
    // a full-window capture.
    const rect = input === undefined ? undefined : parseCaptureRect(input, win.webContents.getZoomFactor())
    if (input !== undefined && !rect) return undefined
    // Native PNG capture: toDataURL already yields a data:image/png;base64 URL.
    return win.webContents.capturePage(rect).then((image) => (image.isEmpty() ? undefined : image.toDataURL()))
  })
  ipcMain.handle("computer-use-click", (event: IpcMainInvokeEvent, appID: string, x: number, y: number) => {
    if (typeof appID !== "string" || typeof x !== "number" || typeof y !== "number") return
    if (isComputerUseTargetAllowed(appID, readComputerUseAllowedApps()) === false) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    clickPane(win, x, y)
  })
  ipcMain.handle("computer-use-type", (event: IpcMainInvokeEvent, appID: string, text: string) => {
    if (typeof appID !== "string" || typeof text !== "string") return
    if (isComputerUseTargetAllowed(appID, readComputerUseAllowedApps()) === false) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    typePane(win, text)
  })
  ipcMain.handle("computer-use-keypress", (event: IpcMainInvokeEvent, appID: string, key: string) => {
    if (typeof appID !== "string" || typeof key !== "string") return
    if (isComputerUseTargetAllowed(appID, readComputerUseAllowedApps()) === false) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    keypressPane(win, key)
  })
  ipcMain.handle("computer-use-scroll", (event: IpcMainInvokeEvent, appID: string, deltaX: number, deltaY: number) => {
    if (typeof appID !== "string" || typeof deltaX !== "number" || typeof deltaY !== "number") return
    if (isComputerUseTargetAllowed(appID, readComputerUseAllowedApps()) === false) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    scrollPane(win, deltaX, deltaY)
  })
  ipcMain.handle("set-force-focus", (event: IpcMainInvokeEvent, enabled: boolean) =>
    setForceFocus(event.sender, enabled),
  )
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("set-native-translations", (event: IpcMainInvokeEvent, value: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Invalid native translation sender")
    }
    const bundle = parseDesktopNativeBundle(value)
    if (!bundle) throw new Error("Invalid native translation bundle")
    deps.setNativeTranslations(bundle)
  })
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })
  ipcMain.handle("draft-get", (_event, key: string) => drafts.get(key))
  ipcMain.handle("draft-set", (_event, key: string, value: string) => drafts.set(key, value))
  ipcMain.handle("draft-delete", (_event, key: string) => drafts.set(key, null))
  ipcMain.handle("draft-blob-put", (_event, data: ArrayBuffer) => drafts.putBlob(new Uint8Array(data)))
  ipcMain.handle("draft-blob-get", (_event, id: string) => {
    const data = drafts.getBlob(id)
    return data ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null
  })

  registerPluginManager(ipcMain, { userDataDir: app.getPath("userData") })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? nativeT("desktop.dialog.chooseFolder"),
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? nativeT("desktop.dialog.chooseFile"),
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? nativeT("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-external", (_event: IpcMainEvent, url: string) => {
    openExternalURL(url)
  })

  ipcMain.on("open-local-file", (_event: IpcMainEvent, url: string) => {
    openLocalFileURL(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("reveal-path", async (_event: IpcMainInvokeEvent, path: string) => {
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    if (!exists) return false
    shell.showItemInFolder(path)
    return true
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("get-window-fullscreen", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFullScreen() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}

export function sendQuickEntry(win: BrowserWindow) {
  win.webContents.send("quick-entry")
}
