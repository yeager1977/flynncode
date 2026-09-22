# MCP Registry Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search the official MCP Registry from the MCP settings tab and configure a selected result as a project- or global-scope Flynncode MCP server via the existing add form.

**Architecture:** Pure frontend. A new `mcp-registry.ts` module queries `registry.modelcontextprotocol.io` directly (CORS is open: `access-control-allow-origin: *`) and maps entries into the existing `McpFormState`; a new dialog component presents search/filter/paginate; `mcp.tsx` gains a "Search registry…" button and a project/global scope toggle in the existing add form. No server or SDK changes.

**Tech Stack:** SolidJS (signals, `createResource`-free fetch with latest-wins guard), Bun test, existing `settings-v2` components (`Dialog`, `ButtonV2`, `TextInputV2`, `Tag`, `SettingsListV2`, `SettingsRowV2`).

**Spec:** `docs/superpowers/specs/2026-09-22-mcp-registry-search-design.md`

## Global Constraints

- Tests run from `packages/app` only (repo guard: `do-not-run-tests-from-root`).
- Typecheck with `bun typecheck` from `packages/app`, never `tsc` directly.
- No `as any`, `@ts-ignore`, star imports, or import aliases. Prefer `const`, early returns, no `else`.
- Registry base URL verbatim: `https://registry.modelcontextprotocol.io/v0.1/servers`, `limit=30`, 5s timeout (`AbortSignal.timeout(5000)`).
- English copy only, added to `packages/app/src/i18n/en.ts` (other locales fall back to en via the loader merge — verified in `src/context/language.tsx`).
- Branch: `mcp-registry-search` from `dev`. Conventional commits, scope `app`.
- The existing add path is the only write path: registry selection prefills the form; nothing is written before the user saves.

---

### Task 1: Registry client — URL builder, response parser, fetcher

**Files:**
- Create: `packages/app/src/components/settings-v2/mcp-registry.ts`
- Test: `packages/app/src/components/settings-v2/mcp-registry.test.ts`

**Interfaces:**
- Consumes: nothing (new module).
- Produces (used by Tasks 2, 5):
  - `type RegistryEntry` (see below)
  - `buildRegistryUrl(query: { search?: string; cursor?: string }): string`
  - `parseRegistryList(json: unknown): { entries: RegistryEntry[]; nextCursor?: string }`
  - `searchRegistry(query: { search?: string; cursor?: string }): Promise<{ entries: RegistryEntry[]; nextCursor?: string }>`
  - `toRegistryEntry(input: unknown, meta?: unknown): RegistryEntry | undefined` (minimal stub in Task 1 — named rows map to `transport: "unsupported"`; full mapping in Task 2)

```ts
// mcp-registry.ts (Task 1 portion)
export type RegistryEntry = {
  id: string // reverse-DNS name, e.g. "io.github.user/filesystem"
  title: string // last path segment of id
  description: string
  version?: string
  status: "active" | "deprecated"
  // "unsupported" = named entry with no mappable package or remote. Shown in
  // results with a disabled Configure button (spec: disable Select with an
  // explanation) instead of being dropped.
  transport: "stdio" | "remote" | "unsupported"
  local?: { command: string[]; environment: { key: string; value: string; hint?: string }[]; requiredEnv: string[] }
  remote?: { url: string; headers: { key: string; value: string; hint?: string }[]; requiredHeaders: string[] }
}

const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers"
const OFFICIAL_META = "io.modelcontextprotocol.registry/official"

export function buildRegistryUrl(query: { search?: string; cursor?: string }) {
  const params = new URLSearchParams({ limit: "30" })
  if (query.search) params.set("search", query.search)
  if (query.cursor) params.set("cursor", query.cursor)
  return `${REGISTRY_URL}?${params.toString()}`
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

export function parseRegistryList(json: unknown) {
  const raw = asRecord(json)
  const seen = new Map<string, { entry: RegistryEntry; isLatest: boolean }>()
  for (const row of asArray(raw.servers)) {
    const outer = asRecord(row)
    const meta = asRecord(asRecord(outer._meta)[OFFICIAL_META])
    const entry = toRegistryEntry(outer.server, outer._meta)
    if (!entry) continue
    const isLatest = meta.isLatest === true
    const current = seen.get(entry.id)
    // The API returns one row per published version; keep the latest.
    if (current?.isLatest) continue
    seen.set(entry.id, { entry, isLatest })
  }
  return { entries: [...seen.values()].map((row) => row.entry), nextCursor: asString(asRecord(raw.metadata).nextCursor) }
}

export async function searchRegistry(query: { search?: string; cursor?: string }) {
  const response = await fetch(buildRegistryUrl(query), { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`registry ${response.status}`)
  return parseRegistryList(await response.json())
}

// Task 1 ships the minimal stub parse needs: named rows become
// "unsupported" entries so dedupe/pagination work end to end. The full
// packages/remotes mapping replaces this body in Task 2.
export function toRegistryEntry(input: unknown, meta?: unknown): RegistryEntry | undefined {
  const raw = asRecord(input)
  const id = asString(raw.name)
  if (!id) return undefined
  const official = asRecord(asRecord(meta)[OFFICIAL_META])
  const status = asString(official.status) === "deprecated" ? ("deprecated" as const) : ("active" as const)
  return {
    id,
    title: id.slice(id.lastIndexOf("/") + 1),
    description: asString(raw.description) ?? "",
    version: asString(raw.version),
    status,
    transport: "unsupported",
  }
}
```

- [ ] **Step 1: Write the failing test**

```ts
// mcp-registry.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/app`): `bun test --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/mcp-registry.test.ts`
Expected: FAIL — cannot find module `./mcp-registry`.

- [ ] **Step 3: Write minimal implementation**

Create `mcp-registry.ts` with the Task 1 portion shown above (including the `toRegistryEntry` stub).

- [ ] **Step 4: Run test to verify it passes**

Run (from `packages/app`): `bun test --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/mcp-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run (from `packages/app`): `bun typecheck` — expected clean.

```bash
git add packages/app/src/components/settings-v2/mcp-registry.ts packages/app/src/components/settings-v2/mcp-registry.test.ts
git commit -m "feat(app): parse official mcp registry responses"
```

---

### Task 2: Entry mapping — packages/remotes → RegistryEntry, registryToForm

**Files:**
- Modify: `packages/app/src/components/settings-v2/mcp-registry.ts` (replace `toRegistryEntry` stub; add `registryToForm`)
- Modify: `packages/app/src/components/settings-v2/mcp-payload.ts` (type-only: widen env/header row types with optional `hint`)
- Modify: `packages/app/src/components/settings-v2/mcp-registry.test.ts`

**Interfaces:**
- Consumes: `RegistryEntry`, `asRecord`/`asArray`/`asString` from Task 1; `emptyForm`, `McpFormState` from `./mcp-payload` (existing; `scope` field is added in Task 3 — Task 2 does NOT touch `scope`, `emptyForm()` output is used as-is).
- Produces (used by Task 5):
  - `toRegistryEntry(input: unknown, meta?: unknown): RegistryEntry | undefined` — full packages/remotes mapping; named rows with no mappable package or remote map to `transport: "unsupported"`
  - `registryToForm(entry: RegistryEntry, opts: { existingNames: string[] }): { form: McpFormState; noteVars: string[] }`

- [ ] **Step 1: Write the failing tests**

Append to `mcp-registry.test.ts`:

```ts
import { registryToForm, toRegistryEntry } from "./mcp-registry"

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/app`): `bun test --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/mcp-registry.test.ts`
Expected: FAIL — `toRegistryEntry` stub returns undefined; `registryToForm` not exported.

- [ ] **Step 3: Implement**

Replace the `toRegistryEntry` stub and add the mapping in `mcp-registry.ts`. First, the type-only widening in `mcp-payload.ts` (the `hint` is rendered as the value input's placeholder by `KeyValueRows` — wired in Task 4):

```ts
// McpFormState — widen both row types:
environment: { key: string; value: string; hint?: string }[]
headers: { key: string; value: string; hint?: string }[]
```

Then in `mcp-registry.ts`:

```ts
import { emptyForm, type McpFormState } from "./mcp-payload"

const RUNNERS: Record<string, string> = { npm: "npx", pypi: "uvx" }

function packageCommand(pkg: Record<string, unknown>): string[] | undefined {
  const identifier = asString(pkg.identifier)
  const registryType = asString(pkg.registryType)
  if (!identifier || !registryType) return undefined
  const version = asString(pkg.version)
  if (registryType === "oci") {
    const flags = asArray(pkg.environmentVariables).flatMap((row) => {
      const name = asString(asRecord(row).name)
      if (!name) return []
      const value = asString(asRecord(row).default)
      return value === undefined ? ["-e", name] : ["-e", `${name}=${value}`]
    })
    return ["docker", "run", "-i", "--rm", ...flags, version ? `${identifier}:${version}` : identifier]
  }
  const hint = asString(pkg.runtimeHint)
  const runner = hint === "npx" || hint === "bunx" || hint === "uvx" ? hint : RUNNERS[registryType]
  if (!runner) return undefined
  const pinned = !version ? identifier : runner === "uvx" ? `${identifier}==${version}` : `${identifier}@${version}`
  const runtimeArgs = asArray(pkg.runtimeArguments).flatMap((row) => {
    const value = asString(asRecord(row).value)
    return value ? [value] : []
  })
  // npx/bunx already inject -y; drop duplicate flags from runtimeArguments.
  const extras = runner === "uvx" ? runtimeArgs : runtimeArgs.filter((arg) => arg !== "-y")
  return runner === "uvx" ? [runner, pinned, ...extras] : [runner, "-y", pinned, ...extras]
}

// "description · secret · required" — the description becomes the input
// placeholder; the flags tell the user what still needs a value.
function rowHint(record: Record<string, unknown>) {
  const flags = [
    record.isSecret === true ? "secret" : undefined,
    record.isRequired === true && asString(record.default) === undefined ? "required" : undefined,
  ].filter((flag) => flag !== undefined)
  const description = asString(record.description)
  if (description === undefined) return flags.join(" · ")
  return [description, ...flags].join(" · ")
}

function packageEnvironment(pkg: Record<string, unknown>) {
  return asArray(pkg.environmentVariables).flatMap((row) => {
    const record = asRecord(row)
    const name = asString(record.name)
    if (!name) return []
    return [{ key: name, value: asString(record.default) ?? "", hint: rowHint(record) }]
  })
}

function packageRequiredEnv(pkg: Record<string, unknown>) {
  return asArray(pkg.environmentVariables).flatMap((row) => {
    const record = asRecord(row)
    const name = asString(record.name)
    if (!name || record.isRequired !== true || asString(record.default) !== undefined) return []
    return [name]
  })
}

function remoteHeaders(remote: Record<string, unknown>) {
  return asArray(remote.headers).flatMap((row) => {
    const record = asRecord(row)
    const name = asString(record.name)
    const value = asString(record.value)
    if (!name) return []
    // A template like "Bearer {smithery_api_key}" is not a usable value.
    const usable = value !== undefined && !value.includes("{")
    return [{ key: name, value: usable ? value : "", hint: rowHint(record) }]
  })
}

function remoteRequiredHeaders(remote: Record<string, unknown>) {
  return asArray(remote.headers).flatMap((row) => {
    const record = asRecord(row)
    const name = asString(record.name)
    if (!name || record.isRequired !== true) return []
    const value = asString(record.value)
    return value !== undefined && !value.includes("{") ? [] : [name]
  })
}

export function toRegistryEntry(input: unknown, meta?: unknown): RegistryEntry | undefined {
  const raw = asRecord(input)
  const id = asString(raw.name)
  if (!id) return undefined
  const official = asRecord(asRecord(meta)[OFFICIAL_META])
  const status = asString(official.status) === "deprecated" ? ("deprecated" as const) : ("active" as const)
  const base = { id, title: id.slice(id.lastIndexOf("/") + 1), description: asString(raw.description) ?? "", version: asString(raw.version), status }
  const pkg = asArray(raw.packages).map(asRecord).find((candidate) => packageCommand(candidate) !== undefined)
  if (pkg) {
    return {
      ...base,
      transport: "stdio",
      local: { command: packageCommand(pkg) ?? [], environment: packageEnvironment(pkg), requiredEnv: packageRequiredEnv(pkg) },
    }
  }
  const remote = asArray(raw.remotes).map(asRecord).find((candidate) => asString(candidate.url) !== undefined)
  if (remote) {
    return {
      ...base,
      transport: "remote",
      remote: { url: asString(remote.url) ?? "", headers: remoteHeaders(remote), requiredHeaders: remoteRequiredHeaders(remote) },
    }
  }
  return { ...base, transport: "unsupported" }
}

function uniqueName(base: string, taken: string[]) {
  if (!taken.includes(base)) return base
  let index = 2
  while (taken.includes(`${base}-${index}`)) index++
  return `${base}-${index}`
}

export function registryToForm(entry: RegistryEntry, opts: { existingNames: string[] }): { form: McpFormState; noteVars: string[] } {
  const form = emptyForm(uniqueName(entry.title, opts.existingNames))
  if (entry.local) {
    form.kind = "local"
    form.command = [...entry.local.command]
    form.environment = entry.local.environment.map((row) => ({ ...row }))
    return { form, noteVars: entry.local.requiredEnv }
  }
  form.kind = "remote"
  form.url = entry.remote?.url ?? ""
  form.headers = (entry.remote?.headers ?? []).map((row) => ({ ...row }))
  return { form, noteVars: entry.remote?.requiredHeaders ?? [] }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/app`): `bun test --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/mcp-registry.test.ts`
Expected: PASS (all tests from Tasks 1 and 2).

- [ ] **Step 5: Typecheck and commit**

Run (from `packages/app`): `bun typecheck` — expected clean.

```bash
git add packages/app/src/components/settings-v2/mcp-registry.ts packages/app/src/components/settings-v2/mcp-registry.test.ts
git commit -m "feat(app): map registry entries to mcp form state"
```

---

### Task 3: Scope in the payload layer — `scope` field, directory-aware `buildAddInput`

**Files:**
- Modify: `packages/app/src/components/settings-v2/mcp-payload.ts` (`McpFormState` lines 5–22, `buildAddInput` lines 119–158)
- Test: `packages/app/src/components/settings-v2/mcp-payload.test.ts`

**Interfaces:**
- Consumes: existing `McpFormState`, `buildAddInput`.
- Produces (used by Task 4):
  - `McpFormState.scope?: "global" | "directory"` (undefined behaves as `"global"`)
  - `buildAddInput(form, opts?: { keepSecret?: boolean; directory?: string })` returns `{ ok: true; input: { server: string; config: McpServerConfig; directory?: string } } | { ok: false; error: string }` — `directory` present only when `opts.directory` is set AND `form.scope === "directory"`.

- [ ] **Step 1: Write the failing tests**

Append to `mcp-payload.test.ts` (reuse its existing import style; the helpers below import `buildAddInput` and a form factory it already exports or constructs inline):

```ts
const remoteForm = { ...emptyForm("x"), kind: "remote" as const, url: "https://mcp.example.com/mcp" }

describe("buildAddInput scope", () => {
  test("directory scope with directory returns directory", () => {
    const built = buildAddInput({ ...remoteForm, scope: "directory" }, { directory: "/proj" })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.input.directory).toBe("/proj")
  })

  test("global scope ignores directory", () => {
    const built = buildAddInput({ ...remoteForm, scope: "global" }, { directory: "/proj" })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.input.directory).toBeUndefined()
  })

  test("undefined scope behaves as global", () => {
    const built = buildAddInput({ ...remoteForm }, { directory: "/proj" })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.input.directory).toBeUndefined()
  })

  test("no directory option → directory undefined regardless of scope", () => {
    const built = buildAddInput({ ...remoteForm, scope: "directory" })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.input.directory).toBeUndefined()
  })
})
```

Note: if existing tests assert the exact shape of `buildAddInput` output or `emptyForm()`, they still pass — `scope` is optional and `directory` is a new optional output field. Run the full existing file to confirm before proceeding; update any exact-equality expectation by adding the new optional key (do not delete assertions).

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/app`): `bun test --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/mcp-payload.test.ts`
Expected: FAIL — `scope` not on form type / `directory` option unknown (type error) and assertions fail.

- [ ] **Step 3: Implement**

In `mcp-payload.ts`:

1. Add to `McpFormState`: `scope?: "global" | "directory"` (last field, with the comment `// undefined behaves as "global"; set by openForm based on context`).
2. Change `buildAddInput` signature and both return statements:

```ts
export function buildAddInput(
  form: McpFormState,
  opts: { keepSecret?: boolean; directory?: string } = {},
): { ok: true; input: { server: string; config: McpServerConfig; directory?: string } } | { ok: false; error: string } {
```

In the `local` branch, the return becomes:

```ts
    return { ok: true, input: { server: name, config, directory: opts.directory !== undefined && form.scope === "directory" ? opts.directory : undefined } }
```

In the remote branch, the final return becomes:

```ts
  const directory = opts.directory !== undefined && form.scope === "directory" ? opts.directory : undefined
  return { ok: true, input: { server: name, config, directory } }
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/app`): `bun test --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/mcp-payload.test.ts`
Expected: PASS — new and pre-existing tests.

- [ ] **Step 5: Typecheck and commit**

Run (from `packages/app`): `bun typecheck` — expected clean (output type gained an optional key; existing callers unaffected).

```bash
git add packages/app/src/components/settings-v2/mcp-payload.ts packages/app/src/components/settings-v2/mcp-payload.test.ts
git commit -m "feat(app): project scope for mcp server config"
```

---

### Task 4: Scope wiring in `mcp.tsx` — toggle, directory-aware add/remove/edit

**Files:**
- Modify: `packages/app/src/components/settings-v2/mcp.tsx` (`addServer` lines 159–170, `onEdit` lines 210–219, `mcpApi` lines 76–136, `openForm` lines 172–206, header lines 352–363, `McpFormFields` lines 399–546, `McpFormSave` unchanged)
- Modify: `packages/app/src/i18n/en.ts` (two scope labels next to the `settings.mcp.form.*` block)

**Interfaces:**
- Consumes: `buildAddInput` output `input.directory` (Task 3).
- Produces (used by Task 5):
  - `openForm(initial: McpFormState, previous?: { name: string; wasConnected: boolean; scope: "global" | "directory" }, note?: string)` — `note` renders as a `settings-v2-plugins-note` div at the top of the dialog body.
  - `mcpApi().add(server: string, config: McpServerConfig, directory?: string)`
  - `mcpApi().remove(server: string, scope?: "global" | "directory")`
  - Registry selection entry point: `openForm(registryToForm(entry, { existingNames }).form, undefined, note)` (Task 5 calls this).

- [ ] **Step 1: Typecheck baseline**

Run (from `packages/app`): `bun typecheck` — expected clean before changes (Task 3 is backward compatible).

- [ ] **Step 2: Make `mcpApi` scope-aware**

In `mcpApi()`:

`add` gains a third parameter and only includes `directory` when passed:

```ts
add: async (server: string, config: McpServerConfig, directory?: string) => {
  const mutable = (config.type === "local"
    ? { ...config, command: [...config.command] }
    : { ...config }) as McpLocalConfig | McpRemoteConfig
  try {
    await sdk.client.mcp.add({ name: server, config: mutable, ...(directory !== undefined ? { directory } : {}) })
  } catch (error) {
    if (protocol() === "v2") throw error
    await sdk.api.mcp.add({ server, config, ...(directory !== undefined ? location() : {}) })
  }
},
```

`remove` gains a scope parameter. Project scope reads the project config, unsets the server, and patches it back; global scope keeps the existing path:

```ts
remove: async (server: string, scope?: "global" | "directory") => {
  if (scope === "directory" && props.directory !== undefined) {
    const response = await sdk.client.config.get({ directory: props.directory })
    const project = (response.data ?? {}) as Record<string, unknown> & { mcp?: Record<string, unknown> }
    const next = { ...project, mcp: { ...project.mcp } }
    delete next.mcp[server]
    await sdk.client.config.update({ directory: props.directory, config: next })
    return
  }
  const config = serverSync().data.config
  const next = { ...config, mcp: { ...config?.mcp } }
  delete next.mcp[server]
  try {
    await sdk.client.global.config.update({ config: next })
  } catch (error) {
    if (protocol() === "v2") throw error
    await sdk.api.mcp.remove({ server, ...location() })
  }
},
```

- [ ] **Step 3: Thread scope through save and edit**

`addServer` — project scope comes from the form for fresh adds and from `previous` for edits (edit keeps the original scope):

```ts
const addServer = async (form: McpFormState, previous?: { name: string; wasConnected: boolean; scope: "global" | "directory" }) => {
  const built = buildAddInput(form, { keepSecret: previous !== undefined, directory: props.directory })
  if (!built.ok) throw new Error(built.error)
  const api = mcpApi()
  if (previous) {
    if (previous.wasConnected) {
      await api.disconnect(previous.name).catch(() => undefined)
    }
    await api.remove(previous.name, previous.scope)
    await api.add(built.input.server, built.input.config, previous.scope === "directory" ? props.directory : undefined)
    return
  }
  await api.add(built.input.server, built.input.config, built.input.directory)
}
```

`onEdit` resolves the server's original scope (project `mcp` map if present there, else global) and presets the form scope; the scope toggle is hidden during edit:

```ts
const onEdit = (name: string) => {
  void (async () => {
    let scope: "global" | "directory" = "global"
    let existing = serverSync().data.config?.mcp?.[name]
    if (props.directory !== undefined) {
      const response = await serverSdk().client.config.get({ directory: props.directory })
      const project = (response.data ?? {}) as { mcp?: Record<string, unknown> }
      if (project.mcp?.[name] !== undefined) {
        scope = "directory"
        existing = project.mcp[name]
      }
    }
    if (!existing || !("type" in existing)) {
      showToast({ variant: "error", description: language.t("settings.mcp.errors.noConfig", { name }) })
      return
    }
    const config = storedToPayloadConfig(existing)
    const status = (servers() ?? []).find((server) => server.name === name)?.status.status
    openForm(formFromConfig(name, config), { name, wasConnected: status === "connected", scope })
  })()
}
```

- [ ] **Step 4: Scope toggle, note, i18n, and hint rendering in the form dialog**

Add the scope labels to `packages/app/src/i18n/en.ts` next to the other `settings.mcp.form.*` keys (registry keys come later, in Task 5):

```ts
"settings.mcp.form.scope.global": "Global",
"settings.mcp.form.scope.project": "Project",
```

`openForm` gains a third parameter and sets the default scope:

```ts
const openForm = (initial: McpFormState, previous?: { name: string; wasConnected: boolean; scope: "global" | "directory" }, note?: string) => {
  const scope = previous?.scope ?? (props.directory !== undefined ? "directory" : "global")
  const [form] = createStore<McpFormState>({ ...initial, scope, environment: [...initial.environment], headers: [...initial.headers] })
  void dialog.push(() => (
    <Dialog fit>
      <DialogHeader>{/* unchanged */}</DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col gap-4 px-4 pt-4 pb-2">
        <Show when={note !== undefined}>
          <div class="settings-v2-plugins-note">{note}</div>
        </Show>
        <McpFormFields form={form} previous={previous} hasDirectory={props.directory !== undefined} />
      </DialogBody>
      {/* DialogFooter unchanged */}
    </Dialog>
  ))
}
```

(The header and footer JSX is unchanged from the current implementation — keep it as-is, only the `DialogBody` children and the store creation change.)

`KeyValueRows` renders each row's optional `hint` as the value input's placeholder (registry-prefilled rows carry it; manually added rows have none). First widen its prop type to match `McpFormState` — `rows: () => { key: string; value: string; hint?: string }[]` in both the prop type and the `onChange` parameter. Then only the value input changes — the key input and buttons stay as-is:

```tsx
<TextInputV2
  type="text"
  class="flex-1"
  value={row.value}
  placeholder={row.hint}
  onInput={(event) => {
    const next = [...props.rows()]
    next[index()] = { ...next[index()], value: event.currentTarget.value }
    props.onChange(next)
  }}
/>
```

`McpFormFields` gains `hasDirectory: boolean` in its props type and renders the scope toggle after the name field, before the local/remote kind buttons:

```tsx
const McpFormFields: Component<{
  form: McpFormState
  previous?: { name: string; wasConnected: boolean; scope: "global" | "directory" }
  hasDirectory: boolean
}> = (props) => {
```

```tsx
<Show when={props.hasDirectory && props.previous === undefined}>
  <div class="flex gap-2">
    <ButtonV2
      size="normal"
      variant={props.form.scope !== "directory" ? "neutral" : "ghost-muted"}
      onClick={() => (props.form.scope = "global")}
    >
      {language.t("settings.mcp.form.scope.global")}
    </ButtonV2>
    <ButtonV2
      size="normal"
      variant={props.form.scope === "directory" ? "neutral" : "ghost-muted"}
      onClick={() => (props.form.scope = "directory")}
    >
      {language.t("settings.mcp.form.scope.project")}
    </ButtonV2>
  </div>
</Show>
```

- [ ] **Step 5: Typecheck and run existing payload tests**

Run (from `packages/app`): `bun typecheck && bun test --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/mcp-payload.test.ts`
Expected: clean typecheck, PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/components/settings-v2/mcp.tsx
git commit -m "feat(app): project vs global scope in mcp form"
```

---

### Task 5: Registry search dialog, header button, i18n

**Files:**
- Create: `packages/app/src/components/settings-v2/mcp-registry.tsx`
- Modify: `packages/app/src/components/settings-v2/mcp.tsx` (import + `onRegistry` + header button)
- Modify: `packages/app/src/i18n/en.ts` (append keys after the `settings.mcp.*` block, near line 1135)

**Interfaces:**
- Consumes: `searchRegistry`, `RegistryEntry`, `registryToForm` from `./mcp-registry` (Tasks 1–2); `openForm`, `onRegistry` wiring from Task 4.
- Produces: complete user-facing feature.

- [ ] **Step 1: Add i18n keys**

In `packages/app/src/i18n/en.ts`, after the last existing `settings.mcp.*` key:

```ts
"settings.mcp.registry.search": "Search registry…",
"settings.mcp.registry.title": "MCP registry",
"settings.mcp.registry.subtitle": "Search the official MCP registry and configure a server.",
"settings.mcp.registry.placeholder": "Search servers…",
"settings.mcp.registry.filter.all": "All",
"settings.mcp.registry.filter.stdio": "Stdio",
"settings.mcp.registry.filter.remote": "Remote",
"settings.mcp.registry.select": "Configure",
"settings.mcp.registry.deprecated": "Deprecated",
"settings.mcp.registry.typePrompt": "Type to search the MCP registry.",
"settings.mcp.registry.empty": "No results.",
"settings.mcp.registry.error": "Could not reach the MCP registry.",
"settings.mcp.registry.retry": "Retry",
"settings.mcp.registry.loadMore": "Load more",
"settings.mcp.registry.unsupported": "No installable package or remote URL",
"settings.mcp.registry.note": "Prefilled from the MCP registry — provide values for: {{vars}}",
```

- [ ] **Step 2: Create the dialog component**

```tsx
// mcp-registry.tsx
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { searchRegistry, type RegistryEntry } from "./mcp-registry"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const RegistrySearchDialog: Component<{
  onSelect: (entry: RegistryEntry) => void
}> = (props) => {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<"all" | "stdio" | "remote">("all")
  const [entries, setEntries] = createSignal<RegistryEntry[]>([])
  const [cursor, setCursor] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal(false)

  let runId = 0
  const run = async (search: string) => {
    const id = ++runId
    setBusy(true)
    setError(false)
    try {
      const page = await searchRegistry(search === "" ? {} : { search })
      if (id !== runId) return
      setEntries(page.entries)
      setCursor(page.nextCursor)
    } catch {
      if (id !== runId) return
      setEntries([])
      setCursor(undefined)
      setError(true)
    } finally {
      if (id === runId) setBusy(false)
    }
  }

  // No browse-all: an empty query shows a prompt instead of fetching the
  // unfiltered listing (spec choice: search + filters, no browse default).
  createEffect(() => {
    const search = query().trim()
    if (search === "") {
      runId++
      setEntries([])
      setCursor(undefined)
      setBusy(false)
      setError(false)
      return
    }
    const timer = setTimeout(() => void run(search), 300)
    onCleanup(() => clearTimeout(timer))
  })

  const visible = () => {
    const active = filter()
    if (active === "all") return entries()
    // "unsupported" entries only appear under All.
    return entries().filter((entry) => entry.transport === active)
  }

  const loadMore = async () => {
    const next = cursor()
    if (next === undefined) return
    setCursor(undefined)
    setBusy(true)
    try {
      const search = query().trim()
      const page = await searchRegistry(search === "" ? { cursor: next } : { search, cursor: next })
      setEntries((current) => [...current, ...page.entries])
      setCursor(page.nextCursor)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("settings.mcp.registry.title")}
          description={language.t("settings.mcp.registry.subtitle")}
        />
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col gap-4 px-4 pt-4 pb-2">
        <TextInputV2
          type="text"
          value={query()}
          placeholder={language.t("settings.mcp.registry.placeholder")}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <div class="flex gap-2">
          {(["all", "stdio", "remote"] as const).map((value) => (
            <ButtonV2
              size="normal"
              variant={filter() === value ? "neutral" : "ghost-muted"}
              onClick={() => setFilter(value)}
            >
              {language.t(`settings.mcp.registry.filter.${value}`)}
            </ButtonV2>
          ))}
        </div>
        <Show
          when={!error()}
          fallback={
            <div class="settings-v2-plugins-note flex items-center justify-between gap-2">
              <span>{language.t("settings.mcp.registry.error")}</span>
              <ButtonV2 size="normal" variant="outline" disabled={busy()} onClick={() => void run(query().trim())}>
                {language.t("settings.mcp.registry.retry")}
              </ButtonV2>
            </div>
          }
        >
          <Show
            when={visible().length > 0}
            fallback={
              <div class="settings-v2-plugins-note">
                <Show
                  when={query().trim() !== ""}
                  fallback={language.t("settings.mcp.registry.typePrompt")}
                >
                  {busy()
                    ? `${language.t("common.loading")}${language.t("common.loading.ellipsis")}`
                    : language.t("settings.mcp.registry.empty")}
                </Show>
              </div>
            }
          >
            <SettingsListV2>
              <For each={visible()}>
                {(entry) => (
                  <SettingsRowV2
                    title={entry.title}
                    description={
                      <div class="flex items-center gap-2">
                        <Tag variant="neutral">{entry.transport}</Tag>
                        <Show when={entry.status === "deprecated"}>
                          <Tag variant="neutral">{language.t("settings.mcp.registry.deprecated")}</Tag>
                        </Show>
                      </div>
                    }
                  >
                    <div class="flex items-center gap-2">
                      <span class="text-text-muted-base">{entry.description}</span>
                      <Show
                        when={entry.transport !== "unsupported"}
                        fallback={<span class="text-text-muted-base">{language.t("settings.mcp.registry.unsupported")}</span>}
                      >
                        <ButtonV2 size="normal" variant="neutral" onClick={() => props.onSelect(entry)}>
                          {language.t("settings.mcp.registry.select")}
                        </ButtonV2>
                      </Show>
                    </div>
                  </SettingsRowV2>
                )}
              </For>
            </SettingsListV2>
          </Show>
        </Show>
        <Show when={cursor() !== undefined && !error()}>
          <ButtonV2 variant="outline" disabled={busy()} onClick={() => void loadMore()}>
            {language.t("settings.mcp.registry.loadMore")}
          </ButtonV2>
        </Show>
      </DialogBody>
    </Dialog>
  )
}
```

- [ ] **Step 3: Wire the button and selection in `mcp.tsx`**

Add imports:

```tsx
import { RegistrySearchDialog } from "./mcp-registry"
import { registryToForm, type RegistryEntry } from "./mcp-registry"
```

(merge into one import statement per repo style: `import { RegistrySearchDialog, registryToForm, type RegistryEntry } from "./mcp-registry"`)

Add the handler next to `onAdd`:

```ts
const onRegistrySelect = (entry: RegistryEntry) => {
  dialog.close()
  const result = registryToForm(entry, { existingNames: (servers() ?? []).map((server) => server.name) })
  const note = result.noteVars.length > 0 ? language.t("settings.mcp.registry.note", { vars: result.noteVars.join(", ") }) : undefined
  openForm(result.form, undefined, note)
}

const onRegistry = () => {
  void dialog.push(() => <RegistrySearchDialog onSelect={onRegistrySelect} />)
}
```

In the tab header (lines 352–363), add the button before the existing Add button:

```tsx
<div class="flex items-center gap-2">
  <ButtonV2 size="normal" variant="outline" onClick={onRegistry}>
    {language.t("settings.mcp.registry.search")}
  </ButtonV2>
  <ButtonV2 size="normal" variant="neutral" onClick={onAdd}>
    {language.t("settings.mcp.add")}
  </ButtonV2>
</div>
```

- [ ] **Step 4: Verify**

Run (from `packages/app`): `bun typecheck && bun test --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/`
Expected: clean typecheck; all settings-v2 tests PASS.

Manual smoke (optional, needs a running app): open Settings → MCP → "Search registry…", search `filesystem`, apply the Stdio filter, select a result, verify the prefilled form, toggle Project/Global, save, and confirm the server appears in the list.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings-v2/mcp-registry.tsx packages/app/src/components/settings-v2/mcp.tsx packages/app/src/i18n/en.ts
git commit -m "feat(app): mcp registry search dialog"
```