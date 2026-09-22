import { describe, expect, test } from "bun:test"
import { buildRegistryUrl, parseRegistryList } from "./mcp-registry"

describe("buildRegistryUrl", () => {
  test("base url with limit", () => {
    expect(buildRegistryUrl({})).toBe("https://registry.modelcontextprotocol.io/v0.1/servers?limit=30")
  })
  test("search and cursor", () => {
    expect(buildRegistryUrl({ search: "filesystem", cursor: "abc" })).toBe(
      "https://registry.modelcontextprotocol.io/v0.1/servers?limit=30&search=filesystem&cursor=abc",
    )
  })
})

const row = (server: unknown, isLatest = true) => ({
  server,
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest } },
})

const npmServer = {
  name: "io.github.user/remote-filesystem",
  description: "MCP server for remote filesystem operations.",
  version: "0.1.3",
  packages: [
    {
      registryType: "npm",
      identifier: "remote-filesystem-mcp-server",
      version: "0.1.3",
      runtimeHint: "npx",
      transport: { type: "stdio" },
      runtimeArguments: [{ value: "-y", type: "positional" }],
      environmentVariables: [
        { name: "GCS_BUCKET", isRequired: true, description: "Google Cloud Storage bucket name." },
        { name: "GCS_MAKE_PUBLIC", default: "false", description: "Make uploaded files publicly accessible." },
      ],
    },
  ],
}

describe("parseRegistryList", () => {
  test("maps a named row to an unsupported entry (full mapping lands in Task 2)", () => {
    const page = parseRegistryList({ servers: [row(npmServer)] })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({
      id: "io.github.user/remote-filesystem",
      title: "remote-filesystem",
      transport: "unsupported",
      status: "active",
      version: "0.1.3",
    })
    expect(page.nextCursor).toBeUndefined()
  })

  test("dedupes per-version rows keeping isLatest", () => {
    const old = { ...npmServer, version: "0.1.2" }
    const page = parseRegistryList({ servers: [row(old, false), row(npmServer, true)] })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0].version).toBe("0.1.3")
  })

  test("keeps first row when no version is flagged latest", () => {
    const page = parseRegistryList({ servers: [row(npmServer, false)] })
    expect(page.entries).toHaveLength(1)
  })

  test("passes through nextCursor and drops nameless rows", () => {
    const page = parseRegistryList({
      servers: [row({})],
      metadata: { nextCursor: "next" },
    })
    expect(page.entries).toHaveLength(0)
    expect(page.nextCursor).toBe("next")
  })
})