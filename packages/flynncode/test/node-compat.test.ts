import { describe, expect, test } from "bun:test"
import path from "path"

// The packaged desktop app bundles the server with `script/build-node.ts` and
// runs it under Node in an Electron utility process, where the `Bun` global is
// undefined. A stray `Bun.file` there throws a ReferenceError at runtime, often
// as an Effect defect that a recoverable-error handler silently skips. Server
// code (everything except the Bun-only CLI) must use Node APIs, or guard Bun
// access with `typeof Bun` on the same line. `*.bun.ts` files are the Bun
// variants of conditional imports and never reach the Node bundle.
const packages = path.resolve(import.meta.dir, "../..")
const roots = [
  { dir: path.join(packages, "flynncode/src"), skip: ["cli/"] },
  { dir: path.join(packages, "core/src"), skip: [] },
]
const bunGlobal = /\bBun\.[A-Za-z$]/
const bunImport = /^\s*import\s+(?!type\b)[^;]*\bfrom\s+"bun(:[a-z]+)?"/

describe("node compatibility", () => {
  test("server code does not use Bun runtime APIs unguarded", async () => {
    const violations = (
      await Promise.all(
        roots.map(async (root) => {
          const files = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root.dir }))
          return Promise.all(
            files
              .filter((file) => !root.skip.some((prefix) => file.startsWith(prefix)))
              .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".bun.ts"))
              .map(async (file) =>
                (await Bun.file(path.join(root.dir, file)).text())
                  .split("\n")
                  .flatMap((line, index) => {
                    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return []
                    if (line.includes("typeof Bun")) return []
                    if (!bunGlobal.test(line) && !bunImport.test(line)) return []
                    return [`${path.relative(packages, path.join(root.dir, file))}:${index + 1}: ${line.trim()}`]
                  }),
              ),
          )
        }),
      )
    ).flat(2)
    expect(violations).toEqual([])
  })
})
