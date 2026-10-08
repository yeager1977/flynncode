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
  it("treats the Linux basic_text backend as unavailable", () => {
    const basicText = { ...fakeEncryption, getSelectedStorageBackend: () => "basic_text" }
    expect(isKeychainAvailable({ file: "/nonexistent", encryption: basicText, platform: "linux" })).toBe(false)
    expect(isKeychainAvailable({ file: "/nonexistent", encryption: basicText, platform: "darwin" })).toBe(true)
    const libsecret = { ...fakeEncryption, getSelectedStorageBackend: () => "gnome_libsecret" }
    expect(isKeychainAvailable({ file: "/nonexistent", encryption: libsecret, platform: "linux" })).toBe(true)
  })
  it("refuses to store secrets without encryption instead of writing plaintext", async () => {
    const location = await tempFile()
    try {
      expect(await keychainSet("flynncode-anthropic", "sk-ant-test", { file: location.file })).toEqual({
        ok: false,
        reason: "encryption-unavailable",
      })
      const basicText = { ...fakeEncryption, getSelectedStorageBackend: () => "basic_text" }
      expect(
        await keychainSet("flynncode-anthropic", "sk-ant-test", {
          file: location.file,
          encryption: basicText,
          platform: "linux",
        }),
      ).toEqual({ ok: false, reason: "encryption-unavailable" })
      expect(await Bun.file(location.file).exists()).toBe(false)
    } finally {
      await rm(location.dir, { recursive: true, force: true })
    }
  })
  it("round-trips and removes encrypted secrets", async () => {
    const location = await tempFile()
    try {
      const deps = { file: location.file, encryption: fakeEncryption }
      expect(await keychainSet("flynncode-anthropic", "sk-ant-test", deps)).toEqual({ ok: true })
      expect(await keychainGet("flynncode-anthropic", deps)).toBe("sk-ant-test")
      await keychainRemove("flynncode-anthropic", deps)
      expect(await keychainGet("flynncode-anthropic", deps)).toBeUndefined()
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
  it("stores the secrets file with owner-only permissions", async () => {
    const location = await tempFile()
    try {
      await keychainSet("flynncode-anthropic", "sk-ant-test", { file: location.file, encryption: fakeEncryption })
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
      const deps = { file: location.file, encryption: fakeEncryption }
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
