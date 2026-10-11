import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { MachineSyncPlatform } from "@opencode-ai/app/machine-sync-types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"
import type {
  CatalogResult,
  PluginConfigsPayload,
  PluginEntry,
} from "@opencode-ai/app/components/settings-v2/plugins-types"
import type { RelayConfigUpdate } from "../main/sidecar-sync"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@opencode-ai/app/wsl/types"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
  scheme?: "system" | "light" | "dark"
}
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type MobileGatewayStatus = {
  running: boolean
  port: number
  lanUrls: string[]
  launcherUrls: string[]
  tailnetUrls: string[]
  tailnetLauncherUrls: string[]
}

export type CaptureRect = { x: number; y: number; width: number; height: number }

// Every pane call reports an explicit outcome instead of resolving void, so a
// refused or unclaimed request can never be mistaken for a performed one.
// "unavailable" marks a window that cannot serve the request (claim lost or no
// preview pane); the caller stays silent and the claimed executor answers.
export type ComputerUseActuation =
  | { status: "performed" }
  | { status: "refused"; reason: string }
  | { status: "unavailable" }

export type ComputerUseScreenshot =
  | { status: "performed"; screenshot: string }
  | { status: "refused"; reason: string }
  | { status: "unavailable" }

export type ComputerUseAPI = {
  screenshot: (requestID: string, appID: string) => Promise<ComputerUseScreenshot>
  click: (appID: string, x: number, y: number, requestID: string) => Promise<ComputerUseActuation>
  typeText: (appID: string, text: string, requestID: string) => Promise<ComputerUseActuation>
  keypress: (appID: string, key: string, requestID: string) => Promise<ComputerUseActuation>
  scroll: (appID: string, deltaX: number, deltaY: number, requestID: string) => Promise<ComputerUseActuation>
}

export type PreviewHostElement = {
  tag: string
  id?: string
  classes?: string
  text?: string
  rect: CaptureRect
}

export type PreviewHostAPI = {
  attach: (url: string) => Promise<void>
  setBounds: (rect: CaptureRect) => Promise<void>
  setVisible: (visible: boolean) => Promise<void>
  detach: () => Promise<void>
  capture: () => Promise<string | undefined>
  inspect: (rect?: CaptureRect) => Promise<PreviewHostElement | null>
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: () => Promise<ServerReadyData>
  wslServers: WslServersAPI
  updater: UpdaterAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  isFirstLaunchOnboardingPending: () => Promise<boolean>
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null>
  isOldLayoutEligible: () => Promise<boolean>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  checkAppExists: (appName: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  museAuthStatus: () => Promise<{ installed: boolean; loggedIn: boolean }>
  museAuthSync: () => Promise<{ ok: boolean; output: string; code?: "not-found" | "failed" }>
  vendorAuthStatus: () => Promise<{ anthropic: boolean; openai: boolean }>
  vendorAuthSignout: (vendor: string) => Promise<void>
  getMobileGatewayStatus: () => Promise<MobileGatewayStatus>
  getMobilePhonePassword: () => Promise<string | null>
  rotateMobilePhonePassword: () => Promise<string>
  getPhoneAccess: () => Promise<boolean>
  setPhoneAccess: (enabled: boolean) => Promise<void>
  setRelayConfig: (config: RelayConfigUpdate) => Promise<void>
  machineSync: MachineSyncPlatform
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
  draftGet: (key: string) => Promise<string | null>
  draftSet: (key: string, value: string) => Promise<void>
  draftDelete: (key: string) => Promise<void>
  draftBlobPut: (data: ArrayBuffer) => Promise<string>
  draftBlobDiscard: (id: string) => Promise<void>
  draftBlobGet: (id: string) => Promise<ArrayBuffer | null>
  plugins: {
    fetchCatalog: () => Promise<CatalogResult>
    readConfigs: (projectDir?: string) => Promise<PluginConfigsPayload>
    install: (
      name: string,
      entry?: PluginEntry,
      scope?: "global" | "project",
      projectDir?: string,
    ) => Promise<{ ok: true }>
    remove: (name: string, scope: "global" | "project", remember: boolean, projectDir?: string) => Promise<{ ok: true }>
  }

  getWindowID: () => Promise<string>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void
  onQuickEntry: (cb: () => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  getPathForFile: (file: File) => string
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openExternal: (url: string) => void
  openLocalFile: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  revealPath: (path: string) => Promise<boolean>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  getWindowFocused: () => Promise<boolean>
  getWindowFullscreen: () => Promise<boolean>
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  getQuickEntryEnabled: () => Promise<boolean>
  setQuickEntryEnabled: (enabled: boolean) => Promise<void>
  screenshot: () => Promise<{ dataUrl: string } | null>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  capturePage: (rect?: CaptureRect) => Promise<string | undefined>
  computerUse: ComputerUseAPI
  previewHost: PreviewHostAPI
  onHostTeardown: (cb: () => void) => () => void
  setForceFocus: (enabled: boolean) => Promise<void>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
  setNativeTranslations: (bundle: DesktopNativeBundle) => Promise<void>
}
