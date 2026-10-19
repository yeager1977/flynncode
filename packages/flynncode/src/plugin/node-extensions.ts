// Standalone module: Node must be able to import this file directly (the
// loader-probe/children import it), so it has no relative imports at all.
import module from "node:module"
import fs from "node:fs"
import path from "path"
import { pathToFileURL } from "url"

// Upstream plugins are commonly authored and bundled with bun, whose resolver
// accepts extensionless relative imports (`./src/thing`). Node's strict ESM
// resolver rejects them, which silently skips those plugins on the Node-based
// server and desktop sidecar. Register one process-wide resolve hook that only
// activates when Node's default resolution has already failed, and retries the
// specifier with the extensions bun would also try (plus directory index.js).

let registered = false

function stripLookup(value: string) {
  const hit = value.match(/^[^?#]*/)
  return hit ? hit[0] : value
}

function parentDirectory(context: { parentURL?: string | undefined }) {
  const parent = context.parentURL
  if (!parent) return pathToFileURL(process.cwd() + path.sep).href
  return parent
}

function candidates(specifier: string, context: { parentURL?: string | undefined }) {
  const parent = parentDirectory(context)
  const base = stripLookup(specifier)
  return [`${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, `${base}/index.js`, `${base}/index.mjs`].map(
    (candidate) => new URL(candidate, parent).href,
  )
}

export function ensureNodeExtensionlessResolveHook() {
  if (registered) return
  // bun resolves extensionless imports natively; the hook is node-only. The
  // optional lookup avoids a static named import that bun's node:module lacks.
  if (typeof globalThis.Bun !== "undefined") return
  const registerHooks = module.registerHooks
  if (typeof registerHooks !== "function") return
  registered = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../")
      const looksBare = !path.isAbsolute(specifier) && !isRelative && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw error
        // Bare package specifiers whose names simply end in a dot-free segment
        // are package lookups, not local files; leave them to Node.
        if (!isRelative && !looksBare) throw error
        if (looksBare) throw error
        for (const candidate of candidates(specifier, context)) {
          try {
            if (!fs.existsSync(new URL(candidate))) continue
            return nextResolve(candidate, context)
          } catch {}
        }
        throw error
      }
    },
  })
}