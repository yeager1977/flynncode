export * as MachineSyncConfig from "./config-sync"

import { applyEdits, modify } from "jsonc-parser"
import { isRecord } from "@/util/record"

export const SECRET_PLACEHOLDER = "__flynncode_sync_secret__"

const SECRET_KEY = /(apiKey|api_key|token|secret|password)$/i
// Every value below one of these maps can carry credentials.
const SECRET_MAPS = new Set(["headers", "env", "environment"])
const REFERENCE = /\{(env|file):[^}]*\}/
const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } }

export function isSecretPath(path: readonly string[]) {
  const key = path.at(-1)
  if (key !== undefined && SECRET_KEY.test(key)) return true
  return path.slice(0, -1).some((segment) => SECRET_MAPS.has(segment.toLowerCase()))
}

/** The global config as it may leave this machine: secrets masked, no server block. */
export function sanitizeConfig(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {}
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key !== "server")
      .map(([key, value]) => [key, mask(value, [key])]),
  )
}

/**
 * Rewrites `localText` into the peer's config with jsonc edits so comments in
 * untouched regions survive. Local secret leaves and the local server block
 * always stay; peer placeholders never land; a secret only the peer has stays
 * absent.
 */
export function applyPeerConfig(input: { localText: string; local: unknown; peer: Record<string, unknown> }): string {
  const local = isRecord(input.local) ? input.local : {}
  const restored = restore(input.peer, local, [])
  const target = Object.fromEntries(
    Object.entries(isRecord(restored?.value) ? restored.value : {}).filter(([key]) => key !== "server"),
  )
  const next = local.server === undefined ? target : { ...target, server: local.server }
  return patchTo(input.localText.trim() ? input.localText : "{}", [], local, next)
}

function mask(value: unknown, path: string[]): unknown {
  if (isSecretPath(path) || isReference(value)) return SECRET_PLACEHOLDER
  if (Array.isArray(value)) return value.map((item, index) => mask(item, [...path, String(index)]))
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item, [...path, key])]))
  return value
}

// Merges the peer's value over the local one. `undefined` means "leave this
// key out": a secret the peer has but this machine does not is never created.
function restore(peer: unknown, local: unknown, path: string[]): { value: unknown } | undefined {
  // The peer's own secrets, placeholders and references are never taken, even
  // when a hostile or buggy peer sends them in the clear.
  if (isSecretPath(path) || isForeign(peer)) return keepLocal(local)
  // A local reference is a secret leaf: an edit on the peer does not replace it.
  if (isReference(local)) return { value: local }
  // A local subtree holding secrets is never replaced by a different shape
  // (`lsp: false` over an object, a record over an array, ...).
  if (hasSecret(local, path) && shape(peer) !== shape(local)) return { value: local }
  if (Array.isArray(peer)) {
    // Arrays are replaced whole, so any secret on either side keeps the local array.
    if (hasSecret(peer, path) || hasSecret(local, path)) return keepLocal(local)
    return { value: peer }
  }
  if (!isRecord(peer)) return { value: peer }
  const base = isRecord(local) ? local : {}
  const incoming = Object.entries(peer).flatMap(([key, value]) => {
    const next = restore(value, Object.hasOwn(base, key) ? base[key] : undefined, [...path, key])
    return next ? [[key, next.value] as const] : []
  })
  // Keys the peer no longer has go away, unless their subtree holds a local
  // secret: then it stays whole, so the file keeps validating.
  const kept = Object.entries(base).filter(
    ([key, value]) => !Object.hasOwn(peer, key) && hasSecret(value, [...path, key]),
  )
  return { value: Object.fromEntries([...incoming, ...kept]) }
}

function keepLocal(local: unknown) {
  return local === undefined ? undefined : { value: local }
}

function shape(value: unknown) {
  if (Array.isArray(value)) return "array"
  return isRecord(value) ? "record" : "primitive"
}

function patchTo(text: string, path: string[], from: unknown, to: unknown): string {
  if (isRecord(from) && isRecord(to)) {
    const removed = Object.keys(from)
      .filter((key) => !Object.hasOwn(to, key))
      .reduce((current, key) => edit(current, [...path, key], undefined), text)
    return Object.entries(to).reduce(
      (current, [key, value]) =>
        patchTo(current, [...path, key], Object.hasOwn(from, key) ? from[key] : undefined, value),
      removed,
    )
  }
  if (JSON.stringify(from) === JSON.stringify(to)) return text
  return edit(text, path, to)
}

function edit(text: string, path: string[], value: unknown) {
  return applyEdits(text, modify(text, path, value, FORMAT))
}

function isReference(value: unknown) {
  return typeof value === "string" && REFERENCE.test(value)
}

function isForeign(value: unknown) {
  return value === SECRET_PLACEHOLDER || isReference(value)
}

// True when any leaf below `value` is a secret, a placeholder or a reference.
function hasSecret(value: unknown, path: string[]): boolean {
  if (isSecretPath(path) || isForeign(value)) return true
  if (Array.isArray(value)) return value.some((item, index) => hasSecret(item, [...path, String(index)]))
  if (isRecord(value)) return Object.entries(value).some(([key, item]) => hasSecret(item, [...path, key]))
  return false
}
