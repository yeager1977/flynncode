import { readFile, writeFile } from "node:fs/promises"
import { nativeT } from "./native-translations"

export type VendorStatus = { anthropic: boolean; openai: boolean }

export type VendorEncryption = {
  isEncryptionAvailable(): boolean
  encryptString(secret: string): Buffer
  decryptString(encrypted: Buffer): string
}

export type VendorKeychainDeps = {
  file: string
  encryption?: VendorEncryption
}

export const VENDOR_ACCOUNTS = {
  anthropic: "flynncode-anthropic",
  openai: "flynncode-openai",
} as const

type StoredEntry = { encrypted: boolean; data: string }

async function readStore(file: string): Promise<Record<string, StoredEntry>> {
  const raw = await readFile(file, "utf8").catch(() => undefined)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as Record<string, StoredEntry>
  } catch {
    return {}
  }
}

async function writeStore(file: string, store: Record<string, StoredEntry>): Promise<void> {
  await writeFile(file, JSON.stringify(store), { mode: 0o600 })
}

export function isKeychainAvailable(deps: VendorKeychainDeps): boolean {
  try {
    return deps.encryption?.isEncryptionAvailable() ?? false
  } catch {
    return false
  }
}

// Static operation label for logs. Detail is intentionally dropped so secrets
// can never reach log output through this helper.
export function redactForLog(input: { vendor: string; detail?: string }): string {
  void input.detail
  return `vendor-auth op=${input.vendor} redacted`
}

export async function keychainGet(account: string, deps: VendorKeychainDeps): Promise<string | undefined> {
  const entry = (await readStore(deps.file))[account]
  if (!entry || typeof entry.data !== "string") return undefined
  if (!entry.encrypted) return Buffer.from(entry.data, "base64").toString("utf8")
  if (!deps.encryption || !isKeychainAvailable(deps)) return undefined
  return deps.encryption.decryptString(Buffer.from(entry.data, "base64"))
}

export async function keychainSet(account: string, secret: string, deps: VendorKeychainDeps): Promise<void> {
  if (secret.length === 0) throw new Error(nativeT("desktop.vendorAuth.error.emptySecret"))
  const store = await readStore(deps.file)
  const encrypted = isKeychainAvailable(deps)
  const data = encrypted
    ? Buffer.from(deps.encryption!.encryptString(secret)).toString("base64")
    : Buffer.from(secret, "utf8").toString("base64")
  await writeStore(deps.file, { ...store, [account]: { encrypted, data } })
}

export async function keychainRemove(account: string, deps: VendorKeychainDeps): Promise<void> {
  const store = await readStore(deps.file)
  if (!(account in store)) return
  delete store[account]
  await writeStore(deps.file, store)
}

function isVendor(value: string): value is keyof typeof VENDOR_ACCOUNTS {
  return value === "anthropic" || value === "openai"
}

export async function vendorAuthStatus(deps: VendorKeychainDeps): Promise<VendorStatus> {
  const store = await readStore(deps.file)
  return { anthropic: VENDOR_ACCOUNTS.anthropic in store, openai: VENDOR_ACCOUNTS.openai in store }
}

export async function vendorAuthSignout(vendor: string, deps: VendorKeychainDeps): Promise<void> {
  if (!isVendor(vendor)) throw new Error(nativeT("desktop.vendorAuth.error.unknownVendor"))
  await keychainRemove(VENDOR_ACCOUNTS[vendor], deps)
}

export * as VendorKeychain from "./vendor-keychain"
