import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const SYNC_OUTPUT_LIMIT = 2000

export type MuseAuthStatus = { installed: boolean; loggedIn: boolean }
export type MuseAuthSyncResult = { ok: boolean; output: string; code?: "not-found" | "failed" }

type Deps = {
  home?: string
  pathDirs?: string[]
  hasMuseBinary?: () => Promise<boolean>
}

const homedir = (deps?: Deps) => deps?.home ?? process.env.HOME ?? ""
const pathDirs = (deps?: Deps) => deps?.pathDirs ?? (process.env.PATH ?? "").split(":")

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK)
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

export async function findMuseAuthScript(deps?: Deps): Promise<string | undefined> {
  const home = homedir(deps)
  const local = home ? join(home, ".local", "bin", "muse-opencode-auth") : ""
  if (local && (await exists(local))) return local
  for (const dir of pathDirs(deps).filter(Boolean)) {
    const candidate = join(dir, "muse-opencode-auth")
    if (await exists(candidate)) return candidate
  }
  return undefined
}

async function defaultHasMuseBinary(): Promise<boolean> {
  try {
    await execFileAsync("muse", ["--version"], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

export async function museAuthStatus(deps?: Deps): Promise<MuseAuthStatus> {
  // POSIX-only feature: script lookup uses HOME, colon-separated PATH, and
  // ~/.local/bin plus ~/.config paths, so Windows is explicitly unsupported.
  if (process.platform === "win32") return { installed: false, loggedIn: false }
  const installed = await (deps?.hasMuseBinary ?? defaultHasMuseBinary)()
  if (!installed) return { installed: false, loggedIn: false }
  try {
    const raw = await readFile(join(homedir(deps), ".config", "muse", "auth.json"), "utf8")
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== "object") return { installed: true, loggedIn: false }
    const providers = (data as { providers?: unknown }).providers
    if (!providers || typeof providers !== "object") return { installed: true, loggedIn: false }
    const meta = (providers as { meta?: unknown }).meta
    if (!meta || typeof meta !== "object") return { installed: true, loggedIn: false }
    const key = (meta as { api_key?: unknown }).api_key
    return { installed: true, loggedIn: typeof key === "string" && key.length > 0 }
  } catch {
    return { installed: true, loggedIn: false }
  }
}

export async function runMuseAuthSync(deps?: { script?: string } & Deps): Promise<MuseAuthSyncResult> {
  const script = deps?.script ?? (await findMuseAuthScript(deps))
  if (!script) return { ok: false, output: "", code: "not-found" }
  try {
    const { stdout, stderr } = await execFileAsync(script, { timeout: 120_000 })
    return { ok: true, output: truncateTail([stdout, stderr].filter(Boolean).join("\n")) }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n")
    return { ok: false, output: truncateTail(output), code: "failed" }
  }
}

function truncateTail(value: string) {
  if (value.length <= SYNC_OUTPUT_LIMIT) return value
  return "..." + value.slice(-SYNC_OUTPUT_LIMIT)
}
