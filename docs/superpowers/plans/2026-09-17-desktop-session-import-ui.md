# Desktop Session Import UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop app a Settings section that discovers Claude Code and Codex sessions server-side and imports selected ones into a chosen project.

**Architecture:** Move the pure transcript parsers and discovery from `packages/plugin/src/import/` into `@opencode-ai/core`, add a real-filesystem adapter, expose two new `server.import` routes (`import.sources`, `import.fromSource`) that read the home-directory tool stores server-side, and build a desktop-only Settings section that calls them. The existing `importSession` operation and the TUI flow are reused/left unchanged.

**Tech Stack:** TypeScript, Effect v4 (beta), Drizzle on SQLite, Bun test, SolidJS + Kobalte for the app UI, `@opencode-ai/sdk/v2` HeyApi client.

## Global Constraints

- Never run tests from the repo root; the root `test` script fails by design. Run tests from the package directory.
- Run `bun typecheck` from the package directory, never `tsc` directly. The full `bun turbo typecheck` must pass (31/31) because the pre-push hook runs it.
- Never alias imports and never use star imports. Import the exported namespace by name.
- Module shape: flat top-level exports plus a self-reexport at the bottom (`export * as Foo from "./foo"`).
- In Effect generators, bind services to named variables before calling methods.
- Do not use `any`. Do not add comments unless a constraint is non-obvious.
- Relative imports in `packages/core` and `packages/plugin` use the `.js` extension (nodenext resolution).
- Never hardcode user-visible English strings in app code. Use `language.t(...)` with keys in `packages/app/src/i18n/en.ts`.
- The import handlers must bind their services at group level (matching `packages/server/src/handlers/session.ts:21`). A handler that leaks requirements breaks the embedded `sdk-next` build.
- Do NOT modify the existing TUI plugin (`packages/plugin/src/import/tui.tsx`) or its flow.
- Do NOT modify `packages/plugin/src/import/{types,claude-code,codex,discover}.ts` — the duplication there is deliberate and recorded debt.

---

### Task 1: Move parsers and discovery into core

**Files:**
- Create: `packages/core/src/session/import-source/types.ts`
- Create: `packages/core/src/session/import-source/claude-code.ts`
- Create: `packages/core/src/session/import-source/codex.ts`
- Create: `packages/core/src/session/import-source/discover.ts`
- Test: `packages/core/test/import-source-parsers.test.ts`

**Interfaces:**
- Produces: `ImportedMessage`, `ParsedSession`, `ImportSource` (types); `parseClaudeCode({ path, text })`; `parseCodex({ path, text })`; `discover(input: { source, home, read, list })` returning `Promise<ReadonlyArray<SourceCandidate>>`; `SourceCandidate` with `path`, `source`, `sourceSessionID`, `title`, `cwd`, `time`, `messageCount`.

This is a relocation, not a rewrite. Copy the four plugin files verbatim into core, changing only the relative import extensions if needed and adding the self-reexport line to each. The plugin keeps its copies.

- [ ] **Step 1: Create the core files by copying the plugin originals**

Copy these files, preserving their content exactly:
- `packages/plugin/src/import/types.ts` → `packages/core/src/session/import-source/types.ts`
- `packages/plugin/src/import/claude-code.ts` → `packages/core/src/session/import-source/claude-code.ts`
- `packages/plugin/src/import/codex.ts` → `packages/core/src/session/import-source/codex.ts`
- `packages/plugin/src/import/discover.ts` → `packages/core/src/session/import-source/discover.ts`

Add `export * as ImportSource` style self-reexports at the top of each file, matching sibling core modules. Use these exact namespace names so consumers have one canonical projection:
- `types.ts`: `export * as ImportSourceTypes from "./types"` — but do NOT re-export a namespace named `ImportSource` from `types.ts`, because `types.ts` also exports a type named `ImportSource`. That name collision is a compile error. Instead, skip the self-reexport in `types.ts` and keep its existing named exports.
- `claude-code.ts`: `export * as ClaudeCode from "./claude-code"` at the top.
- `codex.ts`: `export * as Codex from "./codex"` at the top.
- `discover.ts`: `export * as Discover from "./discover"` at the top.

If the parser files import `./types.js`, that path already resolves inside the new directory, so no import edits are needed.

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/import-source-parsers.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { parseClaudeCode } from "@opencode-ai/core/session/import-source/claude-code"
import { parseCodex } from "@opencode-ai/core/session/import-source/codex"

const line = (value: unknown) => JSON.stringify(value)

describe("core import-source parsers", () => {
  it("parses claude code user and assistant text", () => {
    const text = [
      line({
        type: "user",
        uuid: "u1",
        sessionId: "s1",
        cwd: "/work",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Hello" },
      }),
      line({
        type: "assistant",
        uuid: "a1",
        sessionId: "s1",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: "/work",
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      }),
    ].join("\n")
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text })
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(parsed.title).toBe("Hello")
  })

  it("parses codex user text and assistant text from response_item", () => {
    const text = [
      line({ type: "session_meta", payload: { id: "01abc", cwd: "/repo", timestamp: "2026-01-01T00:00:00.000Z" } }),
      line({ type: "event_msg", payload: { type: "user_message", message: "Do it" } }),
      line({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
      }),
    ].join("\n")
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text })
    expect(parsed.sourceSessionID).toBe("01abc")
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("does not throw on malformed lines", () => {
    const parsed = parseClaudeCode({ path: "/tmp/x.jsonl", text: "{not json" })
    expect(parsed.messages).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test test/import-source-parsers.test.ts` (from `packages/core`)
Expected: PASS, 3 tests. If it fails with a module-not-found error, the copy or the path is wrong.

- [ ] **Step 4: Typecheck and commit**

Run: `bun typecheck` (from `packages/core`), expect no errors.

```bash
git add packages/core/src/session/import-source packages/core/test/import-source-parsers.test.ts
git commit -m "feat(core): move transcript parsers and discovery into core"
```

---

### Task 2: Real-filesystem discovery adapter

**Files:**
- Create: `packages/core/src/session/import-source/discover-node.ts`
- Test: `packages/core/test/import-source-discover-node.test.ts`

**Interfaces:**
- Consumes: `discover`, `SourceCandidate` from Task 1; `Global.Path.home` (`packages/core/src/global.ts:19`).
- Produces: `discoverFromHome(input: { source: ImportSource }): Promise<ReadonlyArray<SourceCandidate>>`

The adapter supplies real `read` and `list` callbacks to the injected `discover`. `read` returns `undefined` for a missing file. `list` must return `[]` rather than throwing when the directory does not exist or is not a directory, because `discover` treats every non-`.jsonl` entry as a directory to descend and will call `list` on files.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/import-source-discover-node.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverFromHome } from "@opencode-ai/core/session/import-source/discover-node"

let home = ""

const line = (value: unknown) => JSON.stringify(value)

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "import-home-"))
  await mkdir(join(home, ".claude", "projects", "-work"), { recursive: true })
  await writeFile(
    join(home, ".claude", "projects", "-work", "aaa.jsonl"),
    line({
      type: "user",
      uuid: "u1",
      sessionId: "aaa",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "First prompt" },
    }),
  )
  await writeFile(join(home, ".claude", "projects", "-work", "notes.txt"), "ignore")

  await mkdir(join(home, ".codex", "sessions", "2026", "01", "01"), { recursive: true })
  await writeFile(
    join(home, ".codex", "sessions", "2026", "01", "01", "rollout-1.jsonl"),
    [
      line({ type: "session_meta", payload: { id: "01abc", cwd: "/repo" } }),
      line({ type: "event_msg", payload: { type: "user_message", message: "Hello" } }),
    ].join("\n"),
  )
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

describe("discoverFromHome", () => {
  it("finds claude code sessions and ignores non-jsonl files", async () => {
    const found = await discoverFromHome({ source: "claude-code", home })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ sourceSessionID: "aaa", title: "First prompt", cwd: "/work" })
  })

  it("walks codex nested date directories", async () => {
    const found = await discoverFromHome({ source: "codex", home })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ sourceSessionID: "01abc" })
  })

  it("returns an empty list when the source root is missing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "import-home-empty-"))
    const found = await discoverFromHome({ source: "claude-code", home: empty })
    expect(found).toEqual([])
    await rm(empty, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/import-source-discover-node.test.ts` (from `packages/core`)
Expected: FAIL with "Cannot find module" for `discover-node`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/session/import-source/discover-node.ts`:

```ts
export * as DiscoverNode from "./discover-node"

import { readdir, readFile } from "node:fs/promises"
import { discover, type SourceCandidate } from "./discover.js"
import type { ImportSource } from "./types.js"

async function list(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  return entries.map((entry) => `${directory}/${entry.name}`)
}

async function read(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").catch(() => undefined)
}

export function discoverFromHome(input: {
  readonly source: ImportSource
  readonly home: string
}): Promise<ReadonlyArray<SourceCandidate>> {
  return discover({ source: input.source, home: input.home, read, list })
}
```

If Windows path separators are a concern, use `path.join` inside `list` instead of a template literal. Prefer `path.join` unconditionally — it is simpler and correct everywhere:

```ts
import path from "node:path"
// ...
  return entries.map((entry) => path.join(directory, entry.name))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/import-source-discover-node.test.ts` (from `packages/core`)
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `bun typecheck` (from `packages/core`), expect no errors.

```bash
git add packages/core/src/session/import-source/discover-node.ts packages/core/test/import-source-discover-node.test.ts
git commit -m "feat(core): add real filesystem discovery adapter"
```

---

### Task 3: Protocol routes for sources and from-source

**Files:**
- Modify: `packages/protocol/src/groups/import.ts`
- Test: `packages/protocol/test/import-group.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: endpoint names `import.sources` (`GET /api/import/sources`) and `import.fromSource` (`POST /api/import/from-source`), plus `export const ImportSource` if not already exported.

The `ImportSource` literal schema is currently a private `const` in this file. Export it so the handler and tests can reference the same value.

`import.sources` query is `{ source, directory }`. Its success shape is `{ data: Array<{ path, sourceSessionID, title, cwd, time, messageCount, imported }> }` with `path`, `sourceSessionID`, `title`, `cwd` as strings, `time` a number, `messageCount` a non-negative int, and `imported` a boolean.

`import.fromSource` payload is `{ source, sourceSessionID, sourcePath, title, location }`. Success is `{ data: Session.Info }`. Errors are `[InvalidRequestError, SessionNotFoundError]`.

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/test/import-group.test.ts` a route-surface test. Add these two imports at the top of the file:

```ts
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { makeImportGroup } from "@opencode-ai/protocol/groups/import"
```

Then add this `describe` block after the existing one:

```ts
describe("import group routes", () => {
  const spec = OpenApi.fromApi(HttpApi.make("import-test").add(makeImportGroup())) as {
    paths: Record<string, Record<string, { operationId?: string }>>
  }

  it("exposes import.sources", () => {
    expect(spec.paths["/api/import/sources"]?.get?.operationId).toBe("v2.import.sources")
  })

  it("exposes import.fromSource", () => {
    expect(spec.paths["/api/import/from-source"]?.post?.operationId).toBe("v2.import.fromSource")
  })
})
```

`HttpApi.make(...).add(makeImportGroup())` builds a minimal API containing only the import group, which is all this test needs. Do not use `await import` inside the `describe` callback — a `describe` callback is not async and that is a syntax error.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/import-group.test.ts` (from `packages/protocol`)
Expected: FAIL, both paths undefined.

- [ ] **Step 3: Add the endpoints**

In `packages/protocol/src/groups/import.ts`, export the source schema:

```ts
export const ImportSource = Schema.Literals(["claude-code", "codex"])
```

Replace the existing private `const ImportSource = ...` with this exported form.

Add these two endpoints inside `makeImportGroup`, after the `import.imported` endpoint:

```ts
    .add(
      HttpApiEndpoint.get("import.sources", `${root}/sources`, {
        query: Schema.Struct({
          source: ImportSource,
          directory: Schema.String,
        }),
        success: Schema.Struct({
          data: Schema.Array(
            Schema.Struct({
              path: Schema.String,
              sourceSessionID: Schema.String,
              title: Schema.String,
              cwd: Schema.String,
              time: NonNegativeInt,
              messageCount: NonNegativeInt,
              imported: Schema.Boolean,
            }),
          ),
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.import.sources",
          summary: "List importable sessions",
          description: "Discover Claude Code and Codex sessions available for import into the given directory.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("import.fromSource", `${root}/from-source`, {
        payload: Schema.Struct({
          source: ImportSource,
          sourceSessionID: Schema.String,
          sourcePath: Schema.String,
          title: Schema.String,
          location: Location.Ref,
        }),
        success: Schema.Struct({ data: Session.Info }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.import.fromSource",
          summary: "Import session from source",
          description: "Read a discovered source session, parse it, and import it as a new session.",
        }),
      ),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/import-group.test.ts` (from `packages/protocol`)
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck and commit**

Run: `bun typecheck` (from `packages/protocol`), expect no errors.

```bash
git add packages/protocol/src/groups/import.ts packages/protocol/test/import-group.test.ts
git commit -m "feat(protocol): add import source discovery routes"
```

---

### Task 4: Server handlers for sources and from-source

**Files:**
- Modify: `packages/server/src/handlers/import.ts`
- Test: `packages/server/test/import-source.test.ts`

**Interfaces:**
- Consumes: `discoverFromHome` (Task 2), `parseClaudeCode`/`parseCodex` (Task 1), `SessionImport.importSession` (existing), `SessionImportRegistry.findImported` (existing), `Global.Path.home` (existing).
- Produces: handlers for `import.sources` and `import.fromSource`. The `import.session` and `import.imported` handlers stay as they are.

Path validation is mandatory. `fromSource` must not become an arbitrary-file-read endpoint. It re-runs discovery for the requested source and rejects any `sourcePath` that is not one of the discovered candidates.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/import-source.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "../src/api"

describe("import source routes", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths: Record<string, Record<string, { operationId?: string }>>
  }

  it("exposes the sources listing route", () => {
    expect(spec.paths["/api/import/sources"]?.get?.operationId).toBe("v2.import.sources")
  })

  it("exposes the from-source route", () => {
    expect(spec.paths["/api/import/from-source"]?.post?.operationId).toBe("v2.import.fromSource")
  })
})
```

This guards the route surface. The deeper behaviour (path validation, dual-projection write) is covered by the live check in Task 7 and by core tests; a full handler integration test would require constructing the whole server layer and is deliberately avoided here.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/import-source.test.ts` (from `packages/server`)
Expected: FAIL, both paths undefined until the handler is registered — if it already passes after Task 3, keep it as a regression guard and continue.

- [ ] **Step 3: Add the handlers**

Modify `packages/server/src/handlers/import.ts`. Add these imports:

```ts
import { readFile } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { discoverFromHome } from "@opencode-ai/core/session/import-source/discover-node"
import { parseClaudeCode } from "@opencode-ai/core/session/import-source/claude-code"
import { parseCodex } from "@opencode-ai/core/session/import-source/codex"
```

Also add `InvalidRequestError` to the existing protocol errors import:

```ts
import { InvalidRequestError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
```

Add the two handlers inside the existing `handlers` chain, after `import.imported`:

```ts
      .handle(
        "import.sources",
        Effect.fn(function* (ctx) {
          const candidates = yield* Effect.promise(() =>
            discoverFromHome({ source: ctx.query.source, home: Global.Path.home }),
          )
          const imported = yield* SessionImportRegistry.findImported(database.db, {
            source: ctx.query.source,
            directory: ctx.query.directory,
          })
          const known = new Set(imported.map((item) => item.sourceSessionID))
          return {
            data: candidates.map((item) => ({
              path: item.path,
              sourceSessionID: item.sourceSessionID,
              title: item.title,
              cwd: item.cwd,
              time: Number.isFinite(item.time) ? Math.max(0, Math.floor(item.time)) : 0,
              messageCount: item.messageCount,
              imported: known.has(item.sourceSessionID),
            })),
          }
        }),
      )
      .handle(
        "import.fromSource",
        Effect.fn(function* (ctx) {
          const candidates = yield* Effect.promise(() =>
            discoverFromHome({ source: ctx.payload.source, home: Global.Path.home }),
          )
          const match = candidates.find(
            (item) =>
              item.path === ctx.payload.sourcePath && item.sourceSessionID === ctx.payload.sourceSessionID,
          )
          if (!match)
            return yield* new InvalidRequestError({
              message: "Source path is not a discovered import candidate",
              field: "sourcePath",
            })

          const text = yield* Effect.promise(() => readFile(match.path, "utf8").catch(() => undefined))
          if (text === undefined)
            return yield* new InvalidRequestError({
              message: "Source session could not be read",
              field: "sourcePath",
            })

          const parsed =
            ctx.payload.source === "claude-code"
              ? parseClaudeCode({ path: match.path, text })
              : parseCodex({ path: match.path, text })

          return {
            data: yield* SessionImport.importSession({
              location: ctx.payload.location,
              source: ctx.payload.source,
              sourceSessionID: match.sourceSessionID,
              sourcePath: match.path,
              title: ctx.payload.title || match.title,
              transcript: parsed.messages,
            }).pipe(
              Effect.provideService(SessionV2.Service, session),
              Effect.provideService(EventV2.Service, events),
              Effect.provideService(Database.Service, database),
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
```

The `discoverFromHome` adapter requires an explicit `home`. Pass `home: Global.Path.home` in **both** handlers, exactly as the code above shows. This is what makes the routes read the user's real tool stores rather than a test fixture.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/import-source.test.ts` and `bun typecheck` (from `packages/server`)
Expected: PASS, no type errors. The group-level bindings already exist from the phase-1 fix, so the embedded build stays green — but verify with `bun typecheck` from `packages/sdk-next` as well, since a leaked requirement only shows up there.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/handlers/import.ts packages/server/test/import-source.test.ts
git commit -m "feat(server): add import source discovery handlers"
```

---

### Task 5: Regenerate the client SDK

**Files:**
- Regenerate: `packages/client/src/generated`, `packages/client/src/generated-effect`
- Regenerate: `packages/sdk/js/src/v2/gen`

**Interfaces:**
- Consumes: the protocol group from Task 3.
- Produces: `client.v2.import.sources(...)` and `client.v2.import.fromSource(...)` on the legacy SDK, which Task 6 calls.

- [ ] **Step 1: Regenerate**

Run: `bun run generate` (from `packages/client`), then `bun ./script/build.ts` (from `packages/sdk/js`).

- [ ] **Step 2: Verify the generated surface**

Run: `bun typecheck` from `packages/client` and `packages/sdk/js`.
Then confirm the accessors exist:

```bash
grep -n "fromSource\|sources" packages/sdk/js/src/v2/gen/sdk.gen.ts | head
```

Expected: the `Import` class gains `sources` and `fromSource`, reachable as `client.v2.import.sources(...)` and `client.v2.import.fromSource(...)` (the `import` getter is singular, matching the existing `session`/`imported` methods).

Do not hand-edit generated files. If generation fails, stop and report.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/generated packages/client/src/generated-effect packages/sdk/js/src/v2/gen
git commit -m "chore(sdk): regenerate for import source routes"
```

---

### Task 6: App selection logic and Settings section

**Files:**
- Create: `packages/app/src/components/settings-v2/import-selection.ts`
- Create: `packages/app/src/components/settings-v2/import-sessions.tsx`
- Modify: `packages/app/src/components/settings-v2/dialog-settings-v2.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Test: `packages/app/src/components/settings-v2/import-selection.test.ts`

**Interfaces:**
- Consumes: `client.v2.import.sources` / `.fromSource` (Task 5).
- Produces: `ImportCandidate`, `toggleSelection`, `buildOptions`, `summary` from `import-selection.ts`; the `SettingsImportSessionsV2` component.

`ImportCandidate` mirrors the route shape: `path`, `sourceSessionID`, `title`, `cwd`, `time`, `messageCount`, `imported`.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/components/settings-v2/import-selection.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { buildOptions, summary, toggleSelection, type ImportCandidate } from "./import-selection"

const candidate = (id: string, imported = false): ImportCandidate => ({
  path: `/tmp/${id}.jsonl`,
  sourceSessionID: id,
  title: `title ${id}`,
  cwd: "/work",
  time: 1,
  messageCount: 2,
  imported,
})

describe("import selection", () => {
  it("toggles membership", () => {
    const first = toggleSelection(new Set<string>(), "a")
    expect([...first]).toEqual(["a"])
    expect([...toggleSelection(first, "a")]).toEqual([])
  })

  it("marks imported rows as disabled", () => {
    const options = buildOptions([candidate("a", true), candidate("b")], "query")
    expect(options.map((option) => option.disabled)).toEqual([true, false])
  })

  it("filters by title and source session id", () => {
    const options = buildOptions([candidate("alpha"), candidate("beta")], "bet")
    expect(options.map((option) => option.value.sourceSessionID)).toEqual(["beta"])
  })

  it("summarises counts", () => {
    expect(tally([true, true, true, false])).toEqual({ imported: 3, failed: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/components/settings-v2/import-selection.test.ts` (from `packages/app`)
Expected: FAIL with "Cannot find module" for `./import-selection`.

- [ ] **Step 3: Write the pure selection module**

Create `packages/app/src/components/settings-v2/import-selection.ts`:

```ts
export type ImportCandidate = {
  readonly path: string
  readonly sourceSessionID: string
  readonly title: string
  readonly cwd: string
  readonly time: number
  readonly messageCount: number
  readonly imported: boolean
}

export type SelectionOption = {
  readonly label: string
  readonly disabled: boolean
  readonly value: ImportCandidate
}

export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function buildOptions(
  candidates: ReadonlyArray<ImportCandidate>,
  query: string,
): ReadonlyArray<SelectionOption> {
  const needle = query.trim().toLowerCase()
  return candidates
    .filter((item) => {
      if (!needle) return true
      return (
        item.title.toLowerCase().includes(needle) ||
        item.sourceSessionID.toLowerCase().includes(needle) ||
        item.cwd.toLowerCase().includes(needle)
      )
    })
    .map((item) => ({
      label: `${item.title} · ${item.messageCount}`,
      disabled: item.imported,
      value: item,
    }))
}

export function tally(results: ReadonlyArray<boolean>): { imported: number; failed: number } {
  return results.reduce(
    (acc, ok) => (ok ? { ...acc, imported: acc.imported + 1 } : { ...acc, failed: acc.failed + 1 }),
    { imported: 0, failed: 0 },
  )
}
```

`tally` returns raw counts deliberately. The component renders `language.t("settings.import.summary", counts)`, so no English string lives in this module. That satisfies the app's rule against hardcoded user-visible strings and keeps the count logic testable.

- [ ] **Step 4: Write the Settings section**

Create `packages/app/src/components/settings-v2/import-sessions.tsx`. Model the structure on `packages/app/src/components/settings-v2/mcp.tsx`: that component is the closest precedent because it is a directory-taking Settings section that calls server routes directly.

Use `useServerSDK()` (NOT `useSDK()`). Our routes take `directory` as an explicit request parameter, so a directory-scoped client is unnecessary:

```tsx
const serverSdk = useServerSDK()
// call as: await serverSdk().client.v2.import.sources({ source, directory }, { throwOnError: true })
```

Key behaviours:
- Source toggle: two options, `claude-code` and `codex`.
- Target directory: defaults to the `directory` prop; a "change" action may reuse the existing directory picker. If wiring a picker is too involved, show the current directory and disable the control — but state that in the report rather than silently omitting it.
- Load candidates with `serverSdk().client.v2.import.sources({ source, directory }, { throwOnError: true })`, using `createResource` keyed on the source and directory, matching how `mcp.tsx` loads data.
- Render a search input plus the list. Each row shows title, message count, and cwd, with a `Checkbox` bound to selection via `toggleSelection`. Imported rows render disabled.
- An Import button, disabled when the selection is empty or a request is in flight.
- On import: iterate the selected candidates sequentially, calling `serverSdk().client.v2.import.fromSource({ source, sourceSessionID, sourcePath: candidate.path, title: candidate.title, location: { directory } }, { throwOnError: true })`. Count successes and failures; a failure increments the count and continues.
- On completion, `showToast` with the i18n summary and refresh the candidate list so imported rows become disabled.
- Loading and empty states: show a loading message while the resource loads, and an empty message when there are zero candidates.

Add i18n keys to `packages/app/src/i18n/en.ts`. Add this block before the closing brace, keeping the file's key ordering style:

```ts
  "settings.tab.importSessions": "Import sessions",
  "settings.import.title": "Import sessions",
  "settings.import.description": "Import Claude Code or Codex sessions into this project.",
  "settings.import.source": "Source",
  "settings.import.source.claudeCode": "Claude Code",
  "settings.import.source.codex": "Codex",
  "settings.import.directory": "Target project",
  "settings.import.search": "Search sessions",
  "settings.import.loading": "Loading sessions...",
  "settings.import.empty": "No sessions found.",
  "settings.import.imported": "Already imported",
  "settings.import.action": "Import selected",
  "settings.import.importing": "Importing...",
  "settings.import.summary": "Imported {{imported}}, failed {{failed}}",
  "settings.import.failed": "Session import failed",
```

Use the `settings.import.summary` key in the toast, with the counts from `tally(...)`. Do not display any raw English string from the helper module.

- [ ] **Step 5: Register the tab**

In `packages/app/src/components/settings-v2/dialog-settings-v2.tsx`, add the trigger in the desktop section, next to the plugins gate (a new `<Show>` is not required; the section is desktop-only per the spec, so gate it the same way):

```tsx
                    <Show when={platform.platform === "desktop"}>
                      <TabsV2.Trigger value="import-sessions">
                        <Icon name="download" />
                        {language.t("settings.tab.importSessions")}
                      </TabsV2.Trigger>
                    </Show>
```

Add the matching content panel alongside the other `TabsV2.Content` entries:

```tsx
        <Show when={platform.platform === "desktop"}>
          <TabsV2.Content value="import-sessions" class="settings-v2-panel">
            <SettingsImportSessionsV2 directory={directory()} />
          </TabsV2.Content>
        </Show>
```

Add the import for the component:

```tsx
import { SettingsImportSessionsV2 } from "./import-sessions"
```

Verify the `Icon` name `"download"` exists in the icon set; if it does not, choose the closest existing name from `packages/ui` and use it.

- [ ] **Step 6: Run the test and typecheck**

Run: `bun test src/components/settings-v2/import-selection.test.ts` and `bun typecheck` (from `packages/app`)
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/components/settings-v2/import-selection.ts packages/app/src/components/settings-v2/import-selection.test.ts packages/app/src/components/settings-v2/import-sessions.tsx packages/app/src/components/settings-v2/dialog-settings-v2.tsx packages/app/src/i18n/en.ts
git commit -m "feat(app): add desktop session import settings section"
```

---

### Task 7: Live verification and rebuild

**Files:**
- Modify: `docs/superpowers/specs/2026-09-17-desktop-session-import-ui-design.md` (record results)
- Rebuild: `packages/desktop/dist`

**Interfaces:**
- Consumes: everything above.
- Produces: a verified feature and a refreshed `.deb` in `~/Downloads`.

- [ ] **Step 1: Verify the routes against a live server**

Start an authed server (use tmux per `packages/opencode/AGENTS.md`, and pick a free port):

```bash
cd packages/opencode
OPENCODE_SERVER_PASSWORD=e2e-pass bun run ./src/index.ts serve --port 4531 --hostname 127.0.0.1
```

Then, with `Authorization: Basic ` + base64(`opencode:e2e-pass`):

1. `GET /api/import/sources?source=claude-code&directory=<a real project dir>` → expect 200 and a non-empty list on this machine (real Claude Code sessions exist at `~/.claude/projects`).
2. `POST /api/import/from-source` with the first candidate's `sourcePath`, `sourceSessionID`, `title`, and a `location.directory` → expect 200 and a created session.
3. `GET /api/session/{sessionID}/message` → expect 200 with the imported messages present.
4. `POST /api/import/from-source` with a `sourcePath` that is NOT a discovered candidate (e.g. `/etc/passwd`) → expect 400. This is the security check; a 200 would be a serious defect.
5. Repeat 1-3 for `source=codex`.

Record the actual status codes and a summary of each response body in the spec.

- [ ] **Step 2: Run the full typecheck**

Run: `cd /home/yeager1977/GitHub/flynncode && bun turbo typecheck` from the repo root.
Expected: 31/31 tasks pass, including `@opencode-ai/sdk-next`. The pre-push hook runs this, so it must be green.

- [ ] **Step 3: Run the feature test suites**

```bash
cd packages/core && bun test test/import-source-parsers.test.ts test/import-source-discover-node.test.ts test/session-import.test.ts test/session-import-session.test.ts
cd packages/protocol && bun test test/import-group.test.ts
cd packages/server && bun test test/import-source.test.ts test/import-handler.test.ts
cd packages/app && bun test src/components/settings-v2/import-selection.test.ts
```

Expected: all pass.

- [ ] **Step 4: Record results and commit**

Update the spec's Verification section with the exact commands, status codes, and the honest list of what remains unverified (in particular: whether the Settings section rendered correctly in a running desktop app, if it could not be opened).

```bash
git add docs/superpowers/specs/2026-09-17-desktop-session-import-ui-design.md
git commit -m "docs: record desktop import verification results"
```

- [ ] **Step 5: Rebuild the .deb**

Kill any leftover server/tmux sessions first. Then:

```bash
cd packages/desktop
OPENCODE_CHANNEL=dev NODE_OPTIONS=--max-old-space-size=4096 bun ./scripts/prepare.ts
OPENCODE_CHANNEL=dev bun run build
OPENCODE_CHANNEL=dev npx electron-builder --linux deb --publish never --config electron-builder.config.ts
```

This takes several minutes. Confirm the artifact exists and is a valid package:

```bash
ls -la packages/desktop/dist/*.deb
dpkg-deb -f packages/desktop/dist/opencode-desktop-linux-amd64.deb Package Version Architecture
dpkg-deb --info packages/desktop/dist/opencode-desktop-linux-amd64.deb > /dev/null && echo valid
```

- [ ] **Step 6: Verify the feature is inside the artifact, then copy**

Confirm the packaged server bundle contains the new routes:

```bash
grep -c "from-source\|import.sources" packages/desktop/out/main/chunks/*.js
grep -c "importSessions" packages/desktop/dist/linux-unpacked/resources/app.asar
```

Then copy to Downloads and report the checksum:

```bash
cp packages/desktop/dist/opencode-desktop-linux-amd64.deb ~/Downloads/
sha256sum ~/Downloads/opencode-desktop-linux-amd64.deb
```

---

## Self-Review Notes

**Spec coverage:** Core move (Task 1), real-fs adapter (Task 2), both routes (Task 3), both handlers with the mandatory path validation (Task 4), SDK regen (Task 5), desktop-gated Settings section with source toggle, directory, multi-select, disabled imported rows, progress, and toast (Task 6), live verification including the security check and the `.deb` rebuild (Task 7).

**Deliberate decisions recorded:**

- **The plugin is not touched.** Its parsers now exist twice. This is accepted debt, per the approved spec. If the copies drift, the TUI and the app will disagree about what is importable.
- **`fromSource` re-discovers before importing.** This is what keeps it from being an arbitrary-file-read endpoint. The cost is that discovery runs twice per import (once to list, once to validate).
- **`tally()` returns raw counts**, not a formatted string, so no English lives in the helper and the count logic stays unit-testable. The component renders the `settings.import.summary` i18n key.
- **Task 4's server test guards the route surface only.** A full handler integration test needs the whole server layer; the live check in Task 7 covers the real behaviour, including the security rejection.
- **Windows path separators** are handled by using `path.join` in the adapter's `list` (Task 2, Step 3).

**Known gaps carried into the spec's Verification:** the Settings section's rendered behaviour is not automatically tested; only its pure logic is. If the implementer can open the app, they should confirm the tab, list, selection, and toast once; otherwise it must be reported as unverified.
