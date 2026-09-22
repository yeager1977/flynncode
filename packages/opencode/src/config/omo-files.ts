export * as ConfigOmoFiles from "./omo-files"

import path from "path"
import { type ParseError, applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { isRecord } from "@/util/record"

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

const DEFAULT_PLUGIN_NAME = "oh-my-openagent.jsonc"

export function pluginFile(dir: string, exists: (candidate: string) => boolean): string | undefined {
  return PLUGIN_FILE_NAMES.map((name) => path.join(dir, name)).find(exists)
}

// Spec order: patch the first that exists, otherwise fall back to the
// `.opencode/opencode.jsonc` default so a fresh install stays namespaced.
// The global `config.json` sibling is never a valid target here.
export function openCodeFile(dir: string, exists: (candidate: string) => boolean): string {
  const candidates = [
    path.join(dir, ".opencode", "opencode.jsonc"),
    path.join(dir, ".opencode", "opencode.json"),
    path.join(dir, "opencode.jsonc"),
    path.join(dir, "opencode.json"),
  ].filter((candidate) => !candidate.endsWith("config.json"))
  return candidates.find(exists) ?? candidates[0]
}

// Global scope has no `.opencode/` subdirectory: patch the same file
// `packages/opencode/src/config/config.ts::globalConfigFile()` selects.
// `config.json` is a legitimate legacy target under `~/.config/opencode` and
// must be preserved when it already exists.
export function globalOpenCodeFile(dir: string, exists: (candidate: string) => boolean): string {
  const candidates = [
    path.join(dir, "opencode.jsonc"),
    path.join(dir, "opencode.json"),
    path.join(dir, "config.json"),
  ]
  return candidates.find(exists) ?? candidates[0]
}

export type Scope = "project" | "global"

const resolveOpenCodeFile = (dir: string, exists: (candidate: string) => boolean, scope: Scope) =>
  scope === "global" ? globalOpenCodeFile(dir, exists) : openCodeFile(dir, exists)

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

export type Info = {
  path: string | null
  parseError?: string
  agents: Record<string, unknown>
  categories: Record<string, unknown>
  disabledProviders: string[]
  openCodeDisabledProviders: readonly string[]
}

export class WriteError extends Schema.TaggedErrorClass<WriteError>()("OmoConfigWriteError", {
  message: Schema.String,
  path: Schema.String,
}) {}

const emptyInfo = (openCodeDisabledProviders: readonly string[]): Info => ({
  path: null,
  agents: {},
  categories: {},
  disabledProviders: [],
  openCodeDisabledProviders,
})

// Batch existence checks for the four plugin candidates plus the OpenCode
// candidates for the requested scope so the sync `pluginFile` /
// `openCodeFile` / `globalOpenCodeFile` helpers can decide which path to
// touch without leaking Effect into their signatures.
const openCodeCandidatePaths = (dir: string, scope: Scope) =>
  scope === "global"
    ? [
        path.join(dir, "opencode.jsonc"),
        path.join(dir, "opencode.json"),
        path.join(dir, "config.json"),
      ]
    : [
        path.join(dir, ".opencode", "opencode.jsonc"),
        path.join(dir, ".opencode", "opencode.json"),
        path.join(dir, "opencode.jsonc"),
        path.join(dir, "opencode.json"),
      ]

const readCandidateExists = Effect.fnUntraced(function* (dir: string, scope: Scope) {
  const fs = yield* FSUtil.Service
  const candidates = [
    ...PLUGIN_FILE_NAMES.map((name) => path.join(dir, name)),
    ...openCodeCandidatePaths(dir, scope),
  ]
  const present = yield* Effect.forEach(
    candidates,
    (candidate) =>
      fs.existsSafe(candidate).pipe(Effect.map((exists) => (exists ? candidate : undefined))),
    { concurrency: "unbounded" },
  )
  return new Set(present.filter((candidate): candidate is string => candidate !== undefined))
})

const readOpenCodeBans = Effect.fnUntraced(function* (openCodePath: string) {
  const fs = yield* FSUtil.Service
  const text = yield* fs.readFileStringSafe(openCodePath).pipe(Effect.orDie)
  if (!text) return [] as string[]
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(parsed)) return [] as string[]
  const bans = parsed.disabled_providers
  return Array.isArray(bans) ? bans.filter((value): value is string => typeof value === "string") : []
})

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const readRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

// GET orchestration: report the resolved plugin path (null when missing),
// surface a JSONC parseError without throwing, and always include
// OpenCode's own `disabled_providers` alongside plugin state.
export const readInfo = Effect.fn("ConfigOmoFiles.readInfo")(function* (
  dir: string,
  scope: Scope = "project",
) {
  const fs = yield* FSUtil.Service
  const exists = yield* readCandidateExists(dir, scope)
  const inSet = (candidate: string) => exists.has(candidate)
  const pluginPath = pluginFile(dir, inSet)
  const openCodePath = resolveOpenCodeFile(dir, inSet, scope)
  const openCodeDisabledProviders = exists.has(openCodePath)
    ? yield* readOpenCodeBans(openCodePath)
    : []

  if (!pluginPath) return emptyInfo(openCodeDisabledProviders)

  const text = yield* fs.readFileStringSafe(pluginPath).pipe(Effect.orDie)
  if (!text) return { ...emptyInfo(openCodeDisabledProviders), path: pluginPath }

  const parsed = readPlugin(text)
  if ("parseError" in parsed) {
    return {
      ...emptyInfo(openCodeDisabledProviders),
      path: pluginPath,
      parseError: parsed.parseError,
    }
  }

  return {
    path: pluginPath,
    agents: readRecord(parsed.document.agents),
    categories: readRecord(parsed.document.categories),
    disabledProviders: readStringArray(parsed.document.disabled_providers),
    openCodeDisabledProviders,
  }
})

// PUT orchestration: refuse when the current plugin file cannot be parsed,
// write the plugin file (creating or deleting the fresh JSONC as needed),
// then persist the OpenCode ban list. A failed OpenCode write surfaces as
// `WriteError` naming that path — the plugin file is intentionally not
// rolled back so the caller can warn that the picker may still list a
// banned provider.
export const write = Effect.fn("ConfigOmoFiles.write")(function* (
  dir: string,
  patch: PluginPatch,
  scope: Scope = "project",
) {
  const fs = yield* FSUtil.Service
  const exists = yield* readCandidateExists(dir, scope)
  const inSet = (candidate: string) => exists.has(candidate)
  const existingPluginPath = pluginFile(dir, inSet)
  const pluginPath = existingPluginPath ?? path.join(dir, DEFAULT_PLUGIN_NAME)

  const existingText = existingPluginPath
    ? yield* fs.readFileStringSafe(existingPluginPath).pipe(Effect.orDie)
    : undefined
  if (existingText) {
    const parsed = readPlugin(existingText)
    if ("parseError" in parsed) {
      return yield* new WriteError({
        message: `Existing plugin file could not be parsed: ${parsed.parseError}`,
        path: existingPluginPath!,
      })
    }
  }

  const patched = applyPluginPatch(existingText, patch)
  let pluginWritten = existingPluginPath !== undefined
  if (patched.empty && !existingPluginPath) {
    // Nothing was configured before the request and the patch produced an
    // empty document — do not leave an empty `oh-my-openagent.jsonc` behind.
  } else {
    yield* fs.writeWithDirs(pluginPath, patched.text).pipe(Effect.orDie)
    pluginWritten = true
  }

  const openCodePath = resolveOpenCodeFile(dir, inSet, scope)
  const openCodeExisting = exists.has(openCodePath)
    ? yield* fs.readFileStringSafe(openCodePath).pipe(Effect.orDie)
    : undefined
  const openCodeText = applyOpenCodeBans(openCodeExisting, patch.disabledProviders)
  const openCodeWrite = fs.writeWithDirs(openCodePath, openCodeText).pipe(
    Effect.catch(
      (cause) =>
        new WriteError({
          message: pluginWritten
            ? `Failed to write OpenCode disabled providers to ${openCodePath}: ${cause.message}. The plugin file may already be saved, so a banned provider can still appear in the picker.`
            : `Failed to write OpenCode disabled providers to ${openCodePath}: ${cause.message}.`,
          path: openCodePath,
        }),
    ),
  )
  yield* openCodeWrite

  return yield* readInfo(dir, scope)
})
