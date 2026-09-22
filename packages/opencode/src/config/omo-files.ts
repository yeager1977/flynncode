export * as ConfigOmoFiles from "./omo-files"

import path from "path"
import { type ParseError, applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"

export type PluginPatch = {
  agents: Record<string, Record<string, unknown> | null>
  categories: Record<string, Record<string, unknown> | null>
  disabledProviders: string[]
}

// `oh-my-openagent` is the current package name; the two `oh-my-opencode`
// entries stay for backwards compatibility with existing installs.
const PLUGIN_FILE_NAMES = [
  "oh-my-openagent.jsonc",
  "oh-my-openagent.json",
  "oh-my-opencode.jsonc",
  "oh-my-opencode.json",
] as const

const OPENCODE_FILE_NAMES = ["opencode.jsonc", "opencode.json"] as const

export function pluginFile(dir: string, exists: (candidate: string) => boolean): string | undefined {
  return PLUGIN_FILE_NAMES.map((name) => path.join(dir, name)).find(exists)
}

// Root `<dir>/opencode.{json,jsonc}` files are intentionally not returned.
// The Oh My OpenCode patch always lands under `.opencode/` so a legacy root
// config remains untouched and a fresh install stays namespaced.
export function openCodeFile(dir: string, exists: (candidate: string) => boolean): string {
  const files = OPENCODE_FILE_NAMES.map((name) => path.join(dir, ".opencode", name))
  return files.find(exists) ?? files[0]
}

const FORMAT = {
  formattingOptions: { tabSize: 2, insertSpaces: true },
} as const

function edit(text: string, keyPath: (string | number)[], value: unknown): string {
  return applyEdits(text, modify(text, keyPath, value, FORMAT))
}

export function applyPluginPatch(
  text: string | undefined,
  patch: PluginPatch,
): { text: string; empty: boolean } {
  const source = text?.trim() ? text : "{}"
  const withAgents = Object.entries(patch.agents).reduce(
    (acc, [key, value]) => edit(acc, ["agents", key], value ?? undefined),
    source,
  )
  const withCategories = Object.entries(patch.categories).reduce(
    (acc, [key, value]) => edit(acc, ["categories", key], value ?? undefined),
    withAgents,
  )
  // `disabled_providers` is replaced, never merged. Empty means "delete the
  // key" so the containing document can collapse to `{}` when nothing else
  // is set.
  const next = edit(
    withCategories,
    ["disabled_providers"],
    patch.disabledProviders.length > 0 ? patch.disabledProviders : undefined,
  )
  const errors: ParseError[] = []
  const parsed = parse(next, errors, { allowTrailingComma: true })
  const empty =
    !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0
  return { text: next, empty }
}

export function applyOpenCodeBans(text: string | undefined, bans: string[]): string {
  const source = text?.trim() ? text : "{}"
  return edit(source, ["disabled_providers"], bans.length > 0 ? bans : undefined)
}

export function readPlugin(text: string): { document: Record<string, unknown> } | { parseError: string } {
  const errors: ParseError[] = []
  const data = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    return {
      parseError: errors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join("; "),
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { document: {} }
  return { document: data as Record<string, unknown> }
}
