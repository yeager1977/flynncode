import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"

// Node's strict ESM resolver rejects the extensionless relative imports that
// bun-authored upstream plugins ship in their dist builds
// (e.g. opencode-mobile's `import ... from "./src/push/formatter"`). The plugin
// loader must register a resolve hook so such plugin packages import cleanly
// on the Node sidecar and desktop server, not just under the bun TUI runtime.

function makePluginFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "flynn-plugin-node-esm-"))
  mkdirSync(path.join(root, "dist", "nested"), { recursive: true })
  mkdirSync(path.join(root, "src", "lib", "thing"), { recursive: true })
  writeFileSync(path.join(root, "src", "greet.js"), `export function greet(name) { return "hi " + name }\n`)
  writeFileSync(path.join(root, "src", "lib", "thing", "index.js"), `export const thing = "thing"\n`)
  writeFileSync(path.join(root, "dist", "nested", "plugin-part.js"), `export const thing = "nested"\n`)
  // Extensionless relative imports: the exact pattern Node ESM rejects.
  writeFileSync(
    path.join(root, "dist", "index.mjs"),
    [
      `import { greet } from "../src/greet"`,
      `import { thing } from "./nested/plugin-part"`,
      `import { thing as thingModule } from "../src/lib/thing"`,
      `export default function plugin() { return greet("x") + thing + thingModule }`,
      ``,
    ].join("\n"),
  )
  return root
}

function writeChildScript(root: string) {
  const child = path.join(root, "load-child.mjs")
  writeFileSync(
    child,
    [
      `const [, , hookPath, entryPath] = process.argv`,
      `const hook = await import(hookPath)`,
      `hook.ensureNodeExtensionlessResolveHook()`,
      `const mod = await import(entryPath)`,
      `if (typeof mod.default !== "function") process.exit(3)`,
      `console.log("LOADED " + mod.default())`,
      ``,
    ].join("\n"),
  )
  return child
}

describe("plugin loader", () => {
  it("registers a Node resolve hook so extensionless ESM plugin builds import under node", () => {
    const root = makePluginFixture()
    try {
      const child = writeChildScript(root)
      const hookSource = path.resolve(import.meta.dirname, "../../src/plugin/node-extensions") + ".ts"
      const entry = path.join(root, "dist", "index.mjs")
      const run = spawnSync("node", ["--experimental-strip-types", "--no-warnings", child, hookSource, entry], {
        encoding: "utf8",
        timeout: 30_000,
      })
      expect(run.status).toBe(0)
      expect(run.stdout).toContain("LOADED hi xnestedthing")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})