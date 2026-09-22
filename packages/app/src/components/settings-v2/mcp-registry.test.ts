import { describe, expect, test } from "bun:test"
import { buildRegistryUrl, parseRegistryList, registryToForm, toRegistryEntry } from "./mcp-registry"

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
  test("maps a named row to a stdio entry via packages", () => {
    const page = parseRegistryList({ servers: [row(npmServer)] })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({
      id: "io.github.user/remote-filesystem",
      title: "remote-filesystem",
      transport: "stdio",
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

const dockerServer = {
  name: "io.github.user/imager",
  description: "Runs in docker.",
  version: "2.0.0",
  packages: [
    {
      registryType: "oci",
      identifier: "ghcr.io/user/imager",
      version: "2.0.0",
      runtimeHint: "docker",
      transport: { type: "stdio" },
      environmentVariables: [
        { name: "API_KEY", isRequired: true, isSecret: true, description: "API key for the service." },
        { name: "MODE", default: "rw", description: "Access mode." },
      ],
    },
  ],
}

const remoteServer = {
  name: "ai.smithery/github",
  description: "GitHub API tools.",
  version: "1.0.0",
  remotes: [
    {
      type: "streamable-http",
      url: "https://server.smithery.ai/@smithery-ai/github/mcp",
      headers: [
        { name: "Authorization", value: "Bearer {smithery_api_key}", isRequired: true, isSecret: true, description: "Bearer token for Smithery authentication" },
      ],
    },
  ],
}

describe("toRegistryEntry", () => {
  test("npm → stdio with pinned command and runtime args", () => {
    const entry = toRegistryEntry(npmServer)
    expect(entry?.transport).toBe("stdio")
    // runtimeArguments duplicating the injected -y are dropped.
    expect(entry?.local?.command).toEqual(["npx", "-y", "remote-filesystem-mcp-server@0.1.3"])
    expect(entry?.local?.environment).toEqual([
      { key: "GCS_BUCKET", value: "", hint: "Google Cloud Storage bucket name. · required" },
      { key: "GCS_MAKE_PUBLIC", value: "false", hint: "Make uploaded files publicly accessible." },
    ])
    expect(entry?.local?.requiredEnv).toEqual(["GCS_BUCKET"])
  })

  test("unpinned npm version omits @version", () => {
    const entry = toRegistryEntry({ ...npmServer, version: undefined, packages: [{ ...npmServer.packages[0], version: undefined }] })
    expect(entry?.local?.command).toEqual(["npx", "-y", "remote-filesystem-mcp-server"])
  })

  test("pypi → uvx with == pin and no -y", () => {
    const entry = toRegistryEntry({
      name: "io.github.user/tool",
      packages: [{ registryType: "pypi", identifier: "mcp-tool", version: "1.2.3", runtimeHint: "uvx" }],
    })
    expect(entry?.local?.command).toEqual(["uvx", "mcp-tool==1.2.3"])
  })

  test("oci → docker run with -e flags", () => {
    const entry = toRegistryEntry(dockerServer)
    expect(entry?.local?.command).toEqual(["docker", "run", "-i", "--rm", "-e", "API_KEY", "-e", "MODE=rw", "ghcr.io/user/imager:2.0.0"])
    expect(entry?.local?.requiredEnv).toEqual(["API_KEY"])
  })

  test("remote → url and templated headers stripped", () => {
    const entry = toRegistryEntry(remoteServer)
    expect(entry?.transport).toBe("remote")
    expect(entry?.remote?.url).toBe("https://server.smithery.ai/@smithery-ai/github/mcp")
    expect(entry?.remote?.headers).toEqual([
      { key: "Authorization", value: "", hint: "Bearer token for Smithery authentication · secret · required" },
    ])
    expect(entry?.remote?.requiredHeaders).toEqual(["Authorization"])
  })

  test("unmappable entry falls back to unsupported transport", () => {
    expect(toRegistryEntry({ name: "com.unknown/nothing" })).toMatchObject({ id: "com.unknown/nothing", transport: "unsupported" })
    expect(toRegistryEntry({})).toBeUndefined()
  })
})

describe("registryToForm", () => {
  test("npm entry → local form with env rows and deduped name", () => {
    const entry = toRegistryEntry(npmServer)!
    const result = registryToForm(entry, { existingNames: ["remote-filesystem"] })
    expect(result.form).toMatchObject({
      kind: "local",
      name: "remote-filesystem-2",
      command: entry.local!.command,
      enabled: true,
    })
    expect(result.form.environment).toEqual([
      { key: "GCS_BUCKET", value: "", hint: "Google Cloud Storage bucket name. · required" },
      { key: "GCS_MAKE_PUBLIC", value: "false", hint: "Make uploaded files publicly accessible." },
    ])
    expect(result.noteVars).toEqual(["GCS_BUCKET"])
  })

  test("remote entry → remote form with url and headers", () => {
    const entry = toRegistryEntry(remoteServer)!
    const result = registryToForm(entry, { existingNames: [] })
    expect(result.form).toMatchObject({ kind: "remote", name: "github", url: entry.remote!.url, oauthEnabled: false })
    expect(result.form.headers).toEqual([
      { key: "Authorization", value: "", hint: "Bearer token for Smithery authentication · secret · required" },
    ])
    expect(result.noteVars).toEqual(["Authorization"])
  })

  test("entry with nothing to configure yields empty noteVars", () => {
    const entry = toRegistryEntry({ name: "io.github.user/simple", packages: [{ registryType: "npm", identifier: "simple-mcp" }] })!
    const result = registryToForm(entry, { existingNames: [] })
    expect(result.form.command).toEqual(["npx", "-y", "simple-mcp"])
    expect(result.noteVars).toEqual([])
  })
})