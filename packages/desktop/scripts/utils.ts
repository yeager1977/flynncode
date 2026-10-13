import { $ } from "bun"
import { existsSync } from "node:fs"
import { chmod, copyFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export const RUST_TARGET = Bun.env.RUST_TARGET

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = dirname(dirname(desktopDir))

function hostArtifactName() {
  const os = process.platform === "win32" ? "windows" : process.platform
  return `flynncode-${os}-${process.arch}`
}

function forkCliSource() {
  const binary = process.platform === "win32" ? "flynncode.exe" : "flynncode"
  return join(repoRoot, "packages", "flynncode", "dist", hostArtifactName(), "bin", binary)
}

export async function stageForkCliToResources(options: { buildIfMissing?: boolean } = {}) {
  let source = forkCliSource()
  if (!existsSync(source) && options.buildIfMissing) {
    await $`bun script/build.ts --single`.cwd(join(repoRoot, "packages", "flynncode"))
    source = forkCliSource()
  }
  if (!existsSync(source)) {
    throw new Error(
      `Fork CLI missing at ${source}. Build it with \`bun script/build.ts --single\` in packages/flynncode. Upstream CLI downloads are not supported.`,
    )
  }
  const dest = windowsify(join(desktopDir, "resources", "flynncode-cli"))
  await copyFile(source, dest)
  if (process.platform !== "win32") await chmod(dest, 0o755)
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`

  console.log(`Staged fork CLI to ${dest}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
