// Standalone diagnostic preload: same resolve hook as
// packages/flynncode/src/plugin/node-extensions.ts, injected via --import so
// the PRE-FIX production bundle can be verified without a rebuild.
import module from "node:module"
import fs from "node:fs"
import path from "path"

const registerHooks = module.registerHooks
if (typeof registerHooks === "function") {
  let registered = false
  const strip = (value) => (value.match(/^[^?#]*/) ?? [value])[0]
  const parentOf = (context) => context.parentURL ?? "file://" + process.cwd() + "/"
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        const code = (error ?? {})?.code
        if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw error
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) throw error
        const base = strip(specifier)
        const parent = parentOf(context)
        for (const suffix of [".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs"]) {
          try {
            const candidate = new URL(base + suffix, parent).href
            if (!fs.existsSync(new URL(candidate))) continue
            return nextResolve(candidate, context)
          } catch {}
        }
        throw error
      }
    },
  })
  registered = true
  console.log("[diag] extensionless resolve hook registered")
}