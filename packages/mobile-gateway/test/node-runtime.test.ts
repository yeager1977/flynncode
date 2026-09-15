import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

const packageDir = join(import.meta.dir, "..")
const repoRoot = join(packageDir, "..", "..")
const electronCandidates = [
  join(repoRoot, "packages", "desktop", "node_modules", "electron", "dist", "electron"),
  join(repoRoot, "node_modules", "electron", "dist", "electron"),
]
const electron = electronCandidates.find((path) => existsSync(path))
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