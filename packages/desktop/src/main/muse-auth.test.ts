import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findMuseAuthScript, museAuthStatus, runMuseAuthSync } from "./muse-auth"

async function stubScript(dir: string, body: string) {
  const file = join(dir, "muse-opencode-auth")
  await writeFile(file, "#!/bin/sh\n" + body + "\n")
  await chmod(file, 0o755)
  return file
}

describe("findMuseAuthScript", () => {
  test("prefers the local bin over PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-muse-"))
    try {
      const home = join(dir, "home")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(home, ".local", "bin"), { recursive: true })
      const local = await stubScript(join(home, ".local", "bin"), "exit 0")
      const found = await findMuseAuthScript({ home, pathDirs: [dir] })
      expect(found).toBe(local)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns undefined when absent everywhere", async () => {
    const found = await findMuseAuthScript({ home: "/nonexistent-home", pathDirs: [] })
    expect(found).toBeUndefined()
  })
})

describe("runMuseAuthSync", () => {
  test("returns ok and output on exit 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-muse-"))
    try {
      const script = await stubScript(dir, 'echo "OK: keys match (LLM|...len48)"')
      const result = await runMuseAuthSync({ script })
      expect(result.ok).toBe(true)
      expect(result.output).toContain("OK: keys match")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns failure on non-zero exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-muse-"))
    try {
      const script = await stubScript(dir, 'echo "FAILED"; exit 3')
      const result = await runMuseAuthSync({ script })
      expect(result.ok).toBe(false)
      expect(result.output).toContain("FAILED")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("museAuthStatus", () => {
  test("reports installed and logged in from fixture auth file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-muse-"))
    try {
      const home = join(dir, "home")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(home, ".config", "muse"), { recursive: true })
      await writeFile(
        join(home, ".config", "muse", "auth.json"),
        JSON.stringify({ providers: { meta: { api_key: "K" } } }),
      )
      const status = await museAuthStatus({ home, hasMuseBinary: async () => true })
      expect(status).toEqual({ installed: true, loggedIn: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reports logged out when the credential is absent", async () => {
    const status = await museAuthStatus({ home: "/nonexistent-home", hasMuseBinary: async () => true })
    expect(status).toEqual({ installed: true, loggedIn: false })
  })

  test("reports not installed when the binary is missing", async () => {
    const status = await museAuthStatus({ home: "/nonexistent-home", hasMuseBinary: async () => false })
    expect(status).toEqual({ installed: false, loggedIn: false })
  })
})
