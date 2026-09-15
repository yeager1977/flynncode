import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

const packageDir = join(import.meta.dir, "..")
const repoRoot = join(packageDir, "..", "..")

// In a linked worktree the git common dir lives under the main checkout, so its
// parent is the main checkout root, where Electron stays installed even when a
// worktree bun install prunes the desktop node_modules link.
const mainCheckout = (() => {
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: packageDir,
    stdout: "pipe",
    stderr: "ignore",
  })
  if (git.exitCode !== 0) return undefined
  const commonDir = git.stdout.toString().trim()
  if (!commonDir.endsWith(".git")) return undefined
  return join(commonDir, "..")
})()

const electronCandidates = [
  join(repoRoot, "packages", "desktop", "node_modules", "electron", "dist", "electron"),
  join(repoRoot, "node_modules", "electron", "dist", "electron"),
  ...(mainCheckout === undefined
    ? []
    : [join(mainCheckout, "packages", "desktop", "node_modules", "electron", "dist", "electron")]),
]
const electron = electronCandidates.find((path) => existsSync(path))

if (electron === undefined) {
  const checked = electronCandidates.map((path) => `  - ${path}`).join("\n")
  if (process.env.CI) {
    test("the package loads and serves under Electron's Node without Bun", () => {
      throw new Error(
        `Electron binary not found. This test is the branch's Node-compatibility guarantee and must run in CI. Checked:\n${checked}`,
      )
    })
  } else {
    console.warn(
      `\n[WARN] Skipping the Node runtime test: no Electron binary was found.\n[WARN] Node compatibility is UNVERIFIED in this run.\n[WARN] Checked:\n${checked}\n`,
    )
  }
}

const harness = (dir: string) => join(dir, "test", "fixtures", "node-runtime-harness.mjs")

describe("node runtime", () => {
  test.skipIf(electron === undefined)(
    "the package loads and serves under Electron's Node without Bun",
    async () => {
      const result = await Bun.$`${electron} ${harness(packageDir)}`.env({
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        OPENCODE_SERVER_PASSWORD: "secret",
        OPENCODE_MOBILE_PASSWORD: "phone-secret",
      }).quiet().nothrow()
      expect(result.exitCode).toBe(0)
      const output = result.stdout.toString() + result.stderr.toString()
      expect(output).toContain("NODE_RUNTIME_OK")
    },
    60000,
  )
})