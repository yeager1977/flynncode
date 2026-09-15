import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

const packageDir = join(import.meta.dir, "..")
const repoRoot = join(packageDir, "..", "..")
const electron = join(repoRoot, "packages", "desktop", "node_modules", "electron", "dist", "electron")

const harness = (dir: string) => join(dir, "test", "fixtures", "node-runtime-harness.mjs")

describe("node runtime", () => {
  test("the package loads and serves under Electron's Node without Bun", async () => {
    const electronPath = electron
    if (!existsSync(electronPath)) {
      console.log("skipping: electron binary not installed")
      return
    }
    const script = harness(packageDir)
    const result = await Bun.$`${electronPath} ${script}`.env({
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      OPENCODE_SERVER_PASSWORD: "secret",
      OPENCODE_MOBILE_PASSWORD: "phone-secret",
    }).quiet().nothrow()
    const output = result.stdout.toString() + result.stderr.toString()
    expect(output).toContain("NODE_RUNTIME_OK")
  }, 60000)
})