import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

// Stopping a running instance before its files change is part of every Linux
// package (see the script for why); metainfo ships alongside it.
const linuxFpm = (appId: string) => {
  const stop = path.join(packageDir, "maintainer", "stop-running-instances.sh")
  return [
    metainfoFpm(appId),
    `--before-install=${stop}`,
    `--before-remove=${stop}`,
  ]
}

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.flynncode.desktop.dev",
  beta: "ai.flynncode.desktop.beta",
  prod: "ai.flynncode.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "flynncode-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.flynncode.desktop" becomes
  // "ai.flynncode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*", "!resources/flynncode-cli*"],
  extraResources: [
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["flynncode-cli*"],
          },
        ]
      : []),
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "Flynncode Dev",
    schemes: ["opencode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Flynncode Dev",
        deb: { packageName: "flynncode-dev", fpm: linuxFpm(appId) },
        rpm: { packageName: "flynncode-dev", fpm: linuxFpm(appId) },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Flynncode Beta",
        protocols: { name: "Flynncode Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "yeager1977", repo: "flynncode-beta", channel: "latest" },
        deb: { packageName: "flynncode-beta", fpm: linuxFpm(appId) },
        rpm: { packageName: "flynncode-beta", fpm: linuxFpm(appId) },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Flynncode",
        protocols: { name: "Flynncode", schemes: ["opencode"] },
        publish: { provider: "github", owner: "yeager1977", repo: "flynncode", channel: "latest" },
        deb: { packageName: "flynncode", fpm: linuxFpm(appId) },
        rpm: { packageName: "flynncode", fpm: linuxFpm(appId) },
      }
    }
  }
}

export default getConfig()
