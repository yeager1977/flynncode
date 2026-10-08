import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isKeychainAvailable,
  keychainGet,
  keychainRemove,
  keychainSet,
  redactForLog,
  vendorAuthSignout,
  vendorAuthStatus,
} from "./vendor-keychain"

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), "vendor-keychain-"))
  return { dir, file: join(dir, "vendor-auth.json") }
}

const fakeEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (secret: string) => Buffer.from(`enc:${secret}`),
  decryptString: (encrypted: Buffer) => encrypted.toString().replace(/^enc:/, ""),
}

describe("vendor-keychain", () => {
  it("never includes secrets in log output", () => {
    expect(redactForLog({ vendor: "anthropic", detail: "sk-ant-secret-value" })).not.toContain("sk-ant-secret-value")
    expect(redactForLog({ vendor: "anthropic" })).toContain("anthropic")
  })
  it("reports encryption availability from the backend", () => {
    expect(isKeychainAvailable({ file: "/nonexistent", encryption: fakeEncryption })).toBe(true)
    expect(isKeychainAvailable({ file: "/nonexistent" })).toBe(false)
  })
  it("round-trips secrets through the file fallback", async () => {
    const location = await tempFile()
    try {
      await keychainSet("flynncode-anthropic", "sk-ant-test", { file: location.file })
      expect(await keychainGet("flynncode-anthropic", { file: location.file })).toBe("sk-ant-test")
      await keychainRemove("flynncode-anthropic", { file: location.file })
      expect(await keychainGet("flynncode-anthropic", { file: location.file })).toBeUndefined()
    } finally {
      await rm(location.dir, { recursive: true, force: true })
    }
  })
  it("encrypts at rest when encryption is available", async () => {
    const location = await tempFile()
    try {
      const deps = { file: location.file, encryption: fakeEncryption }
      await keychainSet("flynncode-openai", "plain-secret", deps)
      const raw = await Bun.file(location.file).text()
      expect(raw).not.toContain("plain-secret")
      expect(await keychainGet("flynncode-openai", deps)).toBe("plain-secret")
    } finally {
      await rm(location.dir, { recursive: true, force: true })
    }
  })
  it("stores the fallback file with owner-only permissions", async () => {
    const location = await tempFile()
    try {
      await keychainSet("flynncode-anthropic", "sk-ant-test", { file: location.file })
      const mode = (await stat(location.file)).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      await rm(location.dir, { recursive: true, force: true })
    }
  })
  it("rejects empty secrets without echoing them", async () => {
    const location = await tempFile()
    try {
      await expect(keychainSet("flynncode-anthropic", "", { file: location.file })).rejects.toThrow()
    } finally {
      await rm(location.dir, { recursive: true, force: true })
    }
  })
  it("tracks vendor status and signs out per vendor", async () => {
    const location = await tempFile()
    try {
      const deps = { file: location.file }
      expect(await vendorAuthStatus(deps)).toEqual({ anthropic: false, openai: false })
      await keychainSet("flynncode-anthropic", "sk-ant-test", deps)
      expect(await vendorAuthStatus(deps)).toEqual({ anthropic: true, openai: false })
      await vendorAuthSignout("anthropic", deps)
      expect(await vendorAuthStatus(deps)).toEqual({ anthropic: false, openai: false })
      await expect(vendorAuthSignout("unknown", deps)).rejects.toThrow()
    } finally {
      await rm(location.dir, { recursive: true, force: true })
    }
  })
})
