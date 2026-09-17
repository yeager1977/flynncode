# Session Import (Claude Code / Codex) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user multi-select Claude Code and Codex sessions in the TUI and import each as a native opencode session in a chosen local project, with history visible in both the TUI and the app timeline.

**Architecture:** A format-agnostic core service publishes existing `SessionEvent` and `SessionV1.Event` events so both the V2 `session_message` projection and the V1 `message`/`part` projection are written. A new protocol/server group exposes `POST /api/import/session` and `GET /api/import/imported`. A TUI plugin owns all filesystem discovery and vendor-format parsing, then calls the endpoint.

**Tech Stack:** TypeScript, Effect v4 (beta), Drizzle ORM on SQLite, Bun test, `@opentui/solid` for TUI, `@opencode-ai/plugin/tui`, `@opencode-ai/sdk/v2`.

## Global Constraints

- Never run tests from the repo root; the root `test` script fails by design. Run from the package directory.
- Run `bun typecheck` from the package directory, never `tsc` directly.
- Never alias imports and never use star imports. Import the exported namespace by name (for example `import { SessionEvent } from "@opencode-ai/core/session/event"`).
- Module shape: flat top-level exports plus a self-reexport at the bottom (`export * as Foo from "./foo"`).
- In Effect generators, bind services to named variables before calling methods.
- Dependency direction: `@opencode-ai/schema` <- `@opencode-ai/protocol` <- `@opencode-ai/server`. Client runtime code may depend on Schema and Protocol but never Core or Server.
- Do not add comments unless a constraint is non-obvious.
- Do not use `any`.
- The default branch is `dev`.

---

### Task 1: Core import service

**Files:**
- Create: `packages/core/src/session/import.ts`
- Test: `packages/core/test/session-import.test.ts`

**Interfaces:**
- Consumes: `EventV2.Service` (`packages/core/src/event.ts`), `Database.Service` (`packages/core/src/database/database.ts`), `SessionEvent` (`packages/core/src/session/event.ts`), `SessionMessage` (`packages/core/src/session/message.ts`), `SessionV1` (`packages/core/src/v1/session.ts`), `SessionSchema` (`packages/core/src/session/schema.ts`).
- Produces: `ImportedMessage` type and the `importTranscript` function:
  ```ts
  export type ImportedMessage =
    | { readonly role: "user"; readonly text: string; readonly time: number }
    | { readonly role: "assistant"; readonly text: string; readonly time: number }

  export const importTranscript = (
    events: EventV2.Interface,
    input: { readonly sessionID: SessionSchema.ID; readonly transcript: ReadonlyArray<ImportedMessage> },
  ) => Effect.Effect<void>
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/session-import.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { importTranscript } from "@opencode-ai/core/session/import"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionV2.ID.make("ses_import_test")
const created = DateTime.makeUnsafe(0)

function seed(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

describe("importTranscript", () => {
  it.effect("projects user and assistant text into the V2 message projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)

      yield* importTranscript(events, {
        sessionID,
        transcript: [
          { role: "user", text: "hello", time: 1 },
          { role: "assistant", text: "hi there", time: 2 },
        ],
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])
      expect(messages[0]).toMatchObject({ type: "user", text: "hello" })
      expect(messages[1]).toMatchObject({
        type: "assistant",
        content: [{ type: "text", text: "hi there" }],
      })
    }),
  )

  it.effect("writes the V1 message and part projections", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)

      yield* importTranscript(events, {
        sessionID,
        transcript: [
          { role: "user", text: "hello", time: 1 },
          { role: "assistant", text: "hi there", time: 2 },
        ],
      })

      const messages = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const parts = yield* db
        .select()
        .from(PartTable)
        .where(eq(PartTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      expect(messages).toHaveLength(2)
      expect(parts).toHaveLength(2)
      expect(parts.every((part) => part.data.type === "text")).toBe(true)
    }),
  )

  it.effect("keeps imported usage at zero", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)

      yield* importTranscript(events, {
        sessionID,
        transcript: [{ role: "assistant", text: "no tokens", time: 3 }],
      })

      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(row).toMatchObject({ cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0 })
    }),
  )

  it.effect("publishes durable events so history is replayable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)

      const user = yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_probe"),
        timestamp: created,
        prompt: Prompt.make({ text: "probe" }),
        delivery: "steer",
      })
      expect(user.durable?.seq).toBeGreaterThanOrEqual(0)

      yield* importTranscript(events, {
        sessionID,
        transcript: [{ role: "user", text: "second", time: 4 }],
      })

      const rows = yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.seq)).toEqual([0, 1])
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session-import.test.ts` (from `packages/core`)
Expected: FAIL with "Cannot find module" for `@opencode-ai/core/session/import`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/session/import.ts`:

```ts
export * as SessionImport from "./import"

import { DateTime, Effect } from "effect"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { Prompt } from "./prompt"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionV1 } from "../v1/session"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"

export type ImportedMessage =
  | { readonly role: "user"; readonly text: string; readonly time: number }
  | { readonly role: "assistant"; readonly text: string; readonly time: number }

const importedAgent = "imported"
const importedProviderID = ProviderV2.ID.make("import")
const importedModelID = ModelV2.ID.make("import")

const messageID = (ordinal: number) => SessionMessage.ID.make(`msg_import_${ordinal}`)

export const importTranscript = (
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly transcript: ReadonlyArray<ImportedMessage> },
) =>
  Effect.gen(function* () {
    for (let index = 0; index < input.transcript.length; index++) {
      const item = input.transcript[index]
      if (!item) continue
      const id = messageID(index)
      const timestamp = DateTime.makeUnsafe(item.time)
      if (item.role === "user") {
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: input.sessionID,
          messageID: id,
          timestamp,
          prompt: Prompt.make({ text: item.text }),
          delivery: "steer",
        })
        yield* events.publish(SessionV1.Event.MessageUpdated, {
          sessionID: input.sessionID,
          info: SessionV1.User.make({
            id: SessionV1.MessageID.ascending(id),
            sessionID: input.sessionID,
            role: "user",
            time: { created: item.time },
            agent: importedAgent,
            model: { providerID: importedProviderID, modelID: importedModelID },
          }),
        })
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: input.sessionID,
          time: item.time,
          part: SessionV1.TextPart.make({
            id: SessionV1.PartID.ascending(`prt_import_${index}`),
            sessionID: input.sessionID,
            messageID: SessionV1.MessageID.ascending(id),
            type: "text",
            text: item.text,
          }),
        })
        continue
      }

      const model = { id: importedModelID, providerID: importedProviderID }
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: input.sessionID,
        assistantMessageID: id,
        timestamp,
        agent: importedAgent,
        model,
      })
      yield* events.publish(SessionEvent.Text.Started, {
        sessionID: input.sessionID,
        assistantMessageID: id,
        timestamp,
        textID: `text-import-${index}`,
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: id,
        timestamp,
        textID: `text-import-${index}`,
        text: item.text,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: id,
        timestamp,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: input.sessionID,
        info: SessionV1.Assistant.make({
          id: SessionV1.MessageID.ascending(id),
          sessionID: input.sessionID,
          role: "assistant",
          time: { created: item.time, completed: item.time },
          parentID: SessionV1.MessageID.ascending(messageID(index - 1)),
          modelID: importedModelID,
          providerID: importedProviderID,
          mode: importedAgent,
          agent: importedAgent,
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        }),
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID: input.sessionID,
        time: item.time,
        part: SessionV1.TextPart.make({
          id: SessionV1.PartID.ascending(`prt_import_${index}`),
          sessionID: input.sessionID,
          messageID: SessionV1.MessageID.ascending(id),
          type: "text",
          text: item.text,
        }),
      })
    }
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/session-import.test.ts` (from `packages/core`)
Expected: PASS for all four tests.

- [ ] **Step 5: Typecheck**

Run: `bun typecheck` (from `packages/core`)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/session/import.ts packages/core/test/session-import.test.ts
git commit -m "feat(core): add session transcript import service"
```

---

### Task 2: Imported-session provenance and lookup

**Files:**
- Create: `packages/core/src/session/import-registry.ts`
- Modify: `packages/core/src/session.ts` (accept optional `metadata` on `create` and thread it into the V1 `SessionInfo`)
- Test: `packages/core/test/session-import-registry.test.ts`

**Interfaces:**
- Consumes: `SessionSchema`, `SessionTable`, `Database.Service`, `SessionV2.Service`.
- Produces:
  ```ts
  export const ImportedMetadataKey = "import"
  export type ImportProvenance = {
    readonly source: "claude-code" | "codex"
    readonly sourceSessionID: string
    readonly sourcePath: string
    readonly importedAt: number
  }
  export const encodeProvenance = (input: ImportProvenance): Record<string, unknown>
  export const decodeProvenance = (metadata: unknown): ImportProvenance | undefined
  export const findImported = (
    db: Database.Interface["db"],
    input: { readonly source: ImportProvenance["source"]; readonly directory: string },
  ) => Effect.Effect<ReadonlyArray<{ sourceSessionID: string; sessionID: string }>>
  ```
- Also produces the extended create contract used by Task 4:
  `SessionV2.create({ location, metadata })` where `metadata` is `Record<string, unknown> | undefined`.

**Context the implementer needs:** V2 `Session.Info` (`packages/schema/src/session.ts:21-45`) has **no
`metadata` field**. Only the V1 `SessionInfo` has `metadata` (`packages/schema/src/v1/session.ts:559`).
`SessionV2.create` already fabricates a V1 `SessionInfo` and publishes it through
`SessionV1.Event.Created` (`packages/core/src/session.ts:207-236`), and the projector writes
`info.metadata` into `SessionTable.metadata` (`packages/core/src/session/projector.ts:61`). So
provenance flows by passing `metadata` into `create` and setting it on the fabricated V1 info.

- [ ] **Step 1: Extend `SessionV2.create` to accept metadata**

In `packages/core/src/session.ts`, change `CreateInput` (around line 79) to:

```ts
type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
  metadata?: Record<string, unknown>
}
```

In the `create` implementation, destructure `metadata` from input and add it to
`SessionV1.SessionInfo.make({...})`:

```ts
          title: `New session - ${new Date(now).toISOString()}`,
          metadata: input.metadata,
          agent: input.agent,
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/session-import-registry.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import {
  decodeProvenance,
  encodeProvenance,
  findImported,
} from "@opencode-ai/core/session/import-registry"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])

describe("import provenance", () => {
  it("round-trips through session metadata", () => {
    const encoded = encodeProvenance({
      source: "claude-code",
      sourceSessionID: "abc",
      sourcePath: "/tmp/abc.jsonl",
      importedAt: 5,
    })
    expect(decodeProvenance(encoded)).toEqual({
      source: "claude-code",
      sourceSessionID: "abc",
      sourcePath: "/tmp/abc.jsonl",
      importedAt: 5,
    })
  })

  it("ignores unrelated metadata", () => {
    expect(decodeProvenance({ other: true })).toBeUndefined()
    expect(decodeProvenance(undefined)).toBeUndefined()
    expect(decodeProvenance({ import: { source: "nope" } })).toBeUndefined()
  })

  it.effect("persists provenance through create and finds it by source and directory", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const directory = AbsolutePath.make("/project/imported")

      const session = yield* sessions.create({
        id: SessionV2.ID.make("ses_imported"),
        location: { directory },
        metadata: encodeProvenance({
          source: "codex",
          sourceSessionID: "rollout-1",
          sourcePath: "/tmp/rollout-1.jsonl",
          importedAt: 1,
        }),
      })

      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
      expect(decodeProvenance(row?.metadata)).toMatchObject({ source: "codex", sourceSessionID: "rollout-1" })

      const found = yield* findImported(db, { source: "codex", directory: "/project/imported" })
      expect(found).toEqual([{ sourceSessionID: "rollout-1", sessionID: "ses_imported" }])

      const other = yield* findImported(db, { source: "claude-code", directory: "/project/imported" })
      expect(other).toEqual([])
    }).pipe(Effect.provide(sessionsLayer)),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session-import-registry.test.ts` (from `packages/core`)
Expected: FAIL with "Cannot find module" for `import-registry`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/session/import-registry.ts`:

```ts
export * as SessionImportRegistry from "./import-registry"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionTable } from "./sql"

export const ImportedMetadataKey = "import"

export type ImportProvenance = {
  readonly source: "claude-code" | "codex"
  readonly sourceSessionID: string
  readonly sourcePath: string
  readonly importedAt: number
}

const isSource = (value: unknown): value is ImportProvenance["source"] =>
  value === "claude-code" || value === "codex"

export const encodeProvenance = (input: ImportProvenance): Record<string, unknown> => ({
  [ImportedMetadataKey]: {
    source: input.source,
    sourceSessionID: input.sourceSessionID,
    sourcePath: input.sourcePath,
    importedAt: input.importedAt,
  },
})

export const decodeProvenance = (metadata: unknown): ImportProvenance | undefined => {
  if (typeof metadata !== "object" || metadata === null) return
  const value = (metadata as Record<string, unknown>)[ImportedMetadataKey]
  if (typeof value !== "object" || value === null) return
  const record = value as Record<string, unknown>
  if (!isSource(record.source)) return
  if (typeof record.sourceSessionID !== "string") return
  if (typeof record.sourcePath !== "string") return
  if (typeof record.importedAt !== "number") return
  return {
    source: record.source,
    sourceSessionID: record.sourceSessionID,
    sourcePath: record.sourcePath,
    importedAt: record.importedAt,
  }
}

export const findImported = (
  db: Database.Interface["db"],
  input: { readonly source: ImportProvenance["source"]; readonly directory: string },
) =>
  db
    .select({ id: SessionTable.id, metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.directory, input.directory))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map(
        (rows) =>
          rows
            .map((row) => ({ row, provenance: decodeProvenance(row.metadata) }))
            .filter((item): item is { row: (typeof rows)[number]; provenance: ImportProvenance } => {
              if (!item.provenance) return false
              return item.provenance.source === input.source
            })
            .map((item) => ({
              sourceSessionID: item.provenance.sourceSessionID,
              sessionID: item.row.id,
            })),
      ),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/session-import-registry.test.ts` (from `packages/core`)
Expected: PASS for all three tests.

- [ ] **Step 5: Typecheck and commit**

Run: `bun typecheck` (from `packages/core`), expect no errors.

```bash
git add packages/core/src/session/import-registry.ts packages/core/test/session-import-registry.test.ts
git commit -m "feat(core): add import provenance helpers"
```

---

### Task 3: Protocol import group

**Files:**
- Create: `packages/protocol/src/groups/import.ts`
- Modify: `packages/protocol/src/api.ts` (register the group)
- Test: `packages/protocol/test/import-group.test.ts`

**Interfaces:**
- Consumes: `Location` (`@opencode-ai/schema/location`), `Session` (`@opencode-ai/schema/session`), `HttpApiGroup`, `HttpApiEndpoint`, `OpenApi`.
- Produces:
  - `export const ImportedMessage = Schema.Union([...])` — discriminated on `role`.
  - `export const makeImportGroup = <I, S>(sessionLocationMiddleware: Context.Key<I, S>) => HttpApiGroup`
  - Endpoint names: `import.session`, `import.imported`.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/import-group.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { Schema } from "effect"
import { ImportedMessage } from "@opencode-ai/protocol/groups/import"

const decode = Schema.decodeUnknownSync(ImportedMessage)

describe("ImportedMessage", () => {
  it("accepts user and assistant text", () => {
    expect(decode({ role: "user", text: "hi", time: 1 })).toEqual({ role: "user", text: "hi", time: 1 })
    expect(decode({ role: "assistant", text: "yo", time: 2 })).toEqual({ role: "assistant", text: "yo", time: 2 })
  })

  it("rejects unknown roles and missing text", () => {
    expect(() => decode({ role: "system", text: "x", time: 1 })).toThrow()
    expect(() => decode({ role: "user", time: 1 })).toThrow()
  })

  it("rejects negative timestamps", () => {
    expect(() => decode({ role: "user", text: "x", time: -1 })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/import-group.test.ts` (from `packages/protocol`)
Expected: FAIL with "Cannot find module" for `groups/import`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/protocol/src/groups/import.ts`:

```ts
import { Location } from "@opencode-ai/schema/location"
import { Session } from "@opencode-ai/schema/session"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "../errors"

const ImportSource = Schema.Literals(["claude-code", "codex"])

const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  text: Schema.String,
  time: NonNegativeInt,
})

const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  text: Schema.String,
  time: NonNegativeInt,
})

export const ImportedMessage = Schema.Union([UserMessage, AssistantMessage]).annotate({
  identifier: "ImportedMessage",
})
export type ImportedMessage = typeof ImportedMessage.Type

const root = "/api/import"

export const makeImportGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.import")
    .add(
      HttpApiEndpoint.post("import.session", `${root}/session`, {
        payload: Schema.Struct({
          source: ImportSource,
          sourceSessionID: Schema.String,
          sourcePath: Schema.String,
          title: Schema.String,
          location: Location.Ref,
          transcript: Schema.Array(ImportedMessage),
        }),
        success: Schema.Struct({ data: Session.Info }),
        error: [InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.import.session",
            summary: "Import session",
            description: "Create a session at the requested location and append an imported transcript to it.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("import.imported", `${root}/imported`, {
        query: Schema.Struct({
          source: ImportSource,
          directory: Schema.String,
        }),
        success: Schema.Struct({
          data: Schema.Array(
            Schema.Struct({
              sourceSessionID: Schema.String,
              sessionID: Session.ID,
            }),
          ),
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.import.imported",
          summary: "List imported sessions",
          description: "List source session IDs already imported into the given directory.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "import",
        description: "Experimental session import routes.",
      }),
    )
```

- [ ] **Step 4: Register the group**

In `packages/protocol/src/api.ts`, add the import and wire it into `makeApiFromGroup`:

```ts
import { makeImportGroup } from "./groups/import"
```

Then add after the `makeSessionGroup` line:

```ts
    .add(makeImportGroup(sessionLocationMiddleware))
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/import-group.test.ts` (from `packages/protocol`)
Expected: PASS for all three tests.

- [ ] **Step 6: Typecheck and commit**

Run: `bun typecheck` (from `packages/protocol`), expect no errors.

**Do not run `bun typecheck` from `packages/server` yet.** Registering the group adds a route with no
handler, so `HttpApiBuilder.layer(Api, ...)` in `packages/server/src/routes.ts` will not satisfy its
handler requirements until Task 5 registers `ImportHandler`. `packages/server` typechecks again at
the end of Task 5. This is an expected intermediate state, not a defect to work around.

```bash
git add packages/protocol/src/groups/import.ts packages/protocol/src/api.ts packages/protocol/test/import-group.test.ts
git commit -m "feat(protocol): add session import group"
```

---

### Task 4: Core import-session operation

**Files:**
- Modify: `packages/core/src/session/import.ts` (add `importSession`)
- Test: `packages/core/test/session-import-session.test.ts`

**Interfaces:**
- Consumes: `SessionV2.Service`, `EventV2.Service`, `Database.Service`, `SessionImportRegistry.encodeProvenance`, `importTranscript` from Task 1.
- Produces:
  ```ts
  export const importSession = (input: {
    readonly location: Location.Ref
    readonly source: "claude-code" | "codex"
    readonly sourceSessionID: string
    readonly sourcePath: string
    readonly title: string
    readonly transcript: ReadonlyArray<ImportedMessage>
  }) => Effect.Effect<
    SessionSchema.Info,
    SessionV2.NotFoundError,
    SessionV2.Service | EventV2.Service | Database.Service
  >
  ```

Putting the whole operation in core keeps the server handler a thin adapter and makes the behavior
testable without an HTTP round trip.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/session-import-session.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { importSession } from "@opencode-ai/core/session/import"
import { decodeProvenance, findImported } from "@opencode-ai/core/session/import-registry"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])),
)
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])

describe("importSession", () => {
  it.effect("creates a session, stamps provenance, and writes both projections", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const session = yield* importSession({
        location: { directory: AbsolutePath.make("/project/imported") },
        source: "claude-code",
        sourceSessionID: "abc",
        sourcePath: "/tmp/abc.jsonl",
        title: "Imported thing",
        transcript: [
          { role: "user", text: "hello", time: 1 },
          { role: "assistant", text: "hi", time: 2 },
        ],
      })

      expect(session.title).toBe("Imported thing")

      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
      expect(decodeProvenance(row?.metadata)).toMatchObject({
        source: "claude-code",
        sourceSessionID: "abc",
      })

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({ sessionID: session.id, order: "asc" })
      expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])

      const v1 = yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, session.id)).all().pipe(Effect.orDie)
      expect(v1).toHaveLength(2)

      const found = yield* findImported(db, { source: "claude-code", directory: "/project/imported" })
      expect(found).toEqual([{ sourceSessionID: "abc", sessionID: session.id }])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("sets session time from the transcript bounds", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const session = yield* importSession({
        location: { directory: AbsolutePath.make("/project/imported") },
        source: "codex",
        sourceSessionID: "rollout-2",
        sourcePath: "/tmp/rollout-2.jsonl",
        title: "Time bounds",
        transcript: [
          { role: "user", text: "first", time: 1_000 },
          { role: "assistant", text: "last", time: 5_000 },
        ],
      })
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
      expect(row?.time_created).toBe(1_000)
      expect(row?.time_updated).toBe(5_000)
    }).pipe(Effect.provide(sessionsLayer)),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session-import-session.test.ts` (from `packages/core`)
Expected: FAIL, `importSession` is not exported.

- [ ] **Step 3: Add `importSession` to `packages/core/src/session/import.ts`**

Append:

```ts
export const importSession = (input: {
  readonly location: Location.Ref
  readonly source: "claude-code" | "codex"
  readonly sourceSessionID: string
  readonly sourcePath: string
  readonly title: string
  readonly transcript: ReadonlyArray<ImportedMessage>
}) =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    const bounds = input.transcript.reduce(
      (acc, item) => ({
        created: Math.min(acc.created, item.time),
        updated: Math.max(acc.updated, item.time),
      }),
      { created: Number.POSITIVE_INFINITY, updated: 0 },
    )
    const now = Date.now()

    const session = yield* sessions.create({
      location: input.location,
      metadata: encodeProvenance({
        source: input.source,
        sourceSessionID: input.sourceSessionID,
        sourcePath: input.sourcePath,
        importedAt: now,
      }),
    })

    yield* importTranscript(events, { sessionID: session.id, transcript: input.transcript })

    const created = Number.isFinite(bounds.created) ? bounds.created : now
    const updated = bounds.updated || now
    if (created !== now || updated !== now) {
      yield* db
        .update(SessionTable)
        .set({ time_created: created, time_updated: updated })
        .where(eq(SessionTable.id, session.id))
        .run()
        .pipe(Effect.orDie)
    }
    yield* db
      .update(SessionTable)
      .set({ title: input.title })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)

    return { ...session, title: input.title, time: { created: new Date(created), updated: new Date(updated) } }
  })
```

Add these imports to the file:

```ts
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { Location } from "../location"
import { SessionV2 } from "../session"
import { SessionImportRegistry } from "./import-registry"
import { SessionTable } from "./sql"
```

Use `SessionImportRegistry.encodeProvenance` to avoid a circular import: `import-registry.ts` does
not import `session.ts`, so a direct import is safe. If a cycle appears at typecheck, import
`encodeProvenance` directly from `./import-registry`.

Note: `sessions.create` returns `SessionSchema.Info` whose `time` fields are `DateTime.Utc`, not
`Date`. Match the existing `create` return shape instead of wrapping in `new Date(...)`; return the
stored row through `SessionV2.get(session.id)` after the updates so the returned info reflects the
written title and time:

```ts
    return yield* sessions.get(session.id)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/session-import-session.test.ts` (from `packages/core`)
Expected: PASS for both tests.

- [ ] **Step 5: Typecheck and commit**

Run: `bun typecheck` (from `packages/core`), expect no errors.

```bash
git add packages/core/src/session/import.ts packages/core/test/session-import-session.test.ts
git commit -m "feat(core): add importSession operation"
```

---

### Task 5: Server import handler

**Files:**
- Create: `packages/server/src/handlers/import.ts`
- Modify: `packages/server/src/handlers.ts` (register the handler)
- Test: `packages/server/test/import-handler.test.ts`

**Interfaces:**
- Consumes: `SessionImport.importSession` (Task 4), `SessionImportRegistry.findImported` (Task 2), `Database.Service`, `Api` (`../api`).
- Produces: `export const ImportHandler` — the `HttpApiBuilder.group(Api, "server.import", ...)` layer.

- [ ] **Step 1: Add a test script to `packages/server/package.json`**

`packages/server` has no test script today. Add:

```json
"test": "bun test --timeout 30000 --only-failures"
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/test/import-handler.test.ts`. This test asserts the route surface without a
network round trip, which is the part the handler is responsible for:

```ts
import { describe, expect } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "../src/api"

describe("import routes", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths: Record<string, Record<string, { operationId?: string }>>
  }

  it("exposes the import session route", () => {
    expect(spec.paths["/api/import/session"]?.post?.operationId).toBe("import.session")
  })

  it("exposes the imported listing route", () => {
    expect(spec.paths["/api/import/imported"]?.get?.operationId).toBe("import.imported")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/import-handler.test.ts` (from `packages/server`)
Expected: FAIL, both paths are undefined because Task 3's group is registered but the handler does
not exist — actually the group registration alone makes these paths appear. If the test already
passes after Task 3, keep it: it is a regression guard for the route surface. Continue to Step 4.

- [ ] **Step 4: Write the handler**

Create `packages/server/src/handlers/import.ts`:

```ts
import { Database } from "@opencode-ai/core/database/database"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionImport } from "@opencode-ai/core/session/import"
import { SessionImportRegistry } from "@opencode-ai/core/session/import-registry"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ImportHandler = HttpApiBuilder.group(Api, "server.import", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "import.session",
        Effect.fn(function* (ctx) {
          return {
            data: yield* SessionImport.importSession({
              location: ctx.payload.location,
              source: ctx.payload.source,
              sourceSessionID: ctx.payload.sourceSessionID,
              sourcePath: ctx.payload.sourcePath,
              title: ctx.payload.title,
              transcript: ctx.payload.transcript,
            }),
          }
        }),
      )
      .handle(
        "import.imported",
        Effect.fn(function* (ctx) {
          const { db } = yield* Database.Service
          return {
            data: yield* SessionImportRegistry.findImported(db, {
              source: ctx.query.source,
              directory: ctx.query.directory,
            }),
          }
        }),
      )
  }),
)
```

`SessionV2` is imported for its `Service` dependency resolved through `SessionImport.importSession`.
If the unused import trips lint, remove it; the handler resolves the dependency transitively.

- [ ] **Step 5: Register the handler**

In `packages/server/src/handlers.ts`, add:

```ts
import { ImportHandler } from "./handlers/import"
```

and add `ImportHandler,` to the `Layer.mergeAll(...)` list.

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test test/import-handler.test.ts` and `bun typecheck` (from `packages/server`)
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/handlers/import.ts packages/server/src/handlers.ts packages/server/package.json packages/server/test/import-handler.test.ts
git commit -m "feat(server): add session import handler"
```

---

### Task 6: Regenerate client SDK

**Files:**
- Modify: generated output under `packages/client/src/generated` and `packages/client/src/generated-effect`
- Regenerate: `packages/sdk/js/src/v2/gen`

**Interfaces:**
- Consumes: the protocol group from Task 3.
- Produces: `client.v2.import.session(...)` and `client.v2.import.imported(...)` in the generated SDK, which Task 10 calls.

- [ ] **Step 1: Regenerate the client**

Run: `bun run generate` (from `packages/client`)
Expected: generated files update to include the import group.

- [ ] **Step 2: Regenerate the legacy JS SDK**

Run: `bun ./script/build.ts` (from `packages/sdk/js`)
Expected: `src/v2/gen/sdk.gen.ts` gains an `import` namespace. If `import` is a reserved word in the generated class shape, verify the generated accessor name and record it; Task 10 depends on the exact name; record the accessor as it appears in the generated class.

- [ ] **Step 3: Verify the generated surface**

Run: `bun typecheck` (from `packages/sdk/js`) and `bun typecheck` (from `packages/client`)
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/generated packages/client/src/generated-effect packages/sdk/js/src/v2/gen packages/sdk/js/openapi.json
git commit -m "chore(sdk): regenerate for session import routes"
```

Do not edit any file under `src/generated` or `src/generated-effect` by hand.

---

### Task 7: Claude Code parser

**Files:**
- Create: `packages/plugin/src/import/claude-code.ts`
- Test: `packages/plugin/test/import-claude-code.test.ts`

**Interfaces:**
- Consumes: `ImportedMessage` type (declared locally in this package, see Step 3).
- Produces:
  ```ts
  export type ParsedSession = {
    readonly sourceSessionID: string
    readonly sourcePath: string
    readonly cwd: string
    readonly title: string
    readonly messages: ReadonlyArray<ImportedMessage>
  }
  export const parseClaudeCode = (input: { readonly path: string; readonly text: string }) => ParsedSession
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/plugin/test/import-claude-code.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { parseClaudeCode } from "../src/import/claude-code"

const line = (value: unknown) => JSON.stringify(value)

const fixture = [
  line({ type: "queue-operation", sessionId: "s1" }),
  line({
    type: "user",
    uuid: "u1",
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work",
    message: { role: "user", content: "Hello there" },
  }),
  line({
    type: "assistant",
    uuid: "a1",
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:01.000Z",
    cwd: "/work",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Part one." },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "Part two." },
      ],
    },
  }),
  line({ type: "user", uuid: "u2", sessionId: "s1", isSidechain: true, message: { role: "user", content: "sub" } }),
].join("\n")

describe("parseClaudeCode", () => {
  it("extracts user and assistant text", () => {
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text: fixture })
    expect(parsed.sourceSessionID).toBe("s1")
    expect(parsed.cwd).toBe("/work")
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(parsed.messages[0]?.text).toBe("Hello there")
  })

  it("joins multiple text blocks with a blank line", () => {
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text: fixture })
    expect(parsed.messages[1]?.text).toBe("Part one.\n\nPart two.")
  })

  it("excludes sidechain records", () => {
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text: fixture })
    expect(parsed.messages.some((message) => message.text === "sub")).toBe(false)
  })

  it("skips malformed lines without failing", () => {
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text: `${fixture}\n{not json` })
    expect(parsed.messages).toHaveLength(2)
  })

  it("derives a title from the first user message", () => {
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text: fixture })
    expect(parsed.title).toBe("Hello there")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/import-claude-code.test.ts` (from `packages/plugin`)
Expected: FAIL with "Cannot find module" for `../src/import/claude-code`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/plugin/src/import/types.ts`:

```ts
export type ImportedMessage =
  | { readonly role: "user"; readonly text: string; readonly time: number }
  | { readonly role: "assistant"; readonly text: string; readonly time: number }

export type ParsedSession = {
  readonly sourceSessionID: string
  readonly sourcePath: string
  readonly cwd: string
  readonly title: string
  readonly messages: ReadonlyArray<ImportedMessage>
}

export type ImportSource = "claude-code" | "codex"
```

Create `packages/plugin/src/import/claude-code.ts`:

```ts
import type { ImportedMessage, ParsedSession } from "./types"

type Record_ = Record<string, unknown>

const asRecord = (value: unknown): Record_ | undefined =>
  typeof value === "object" && value !== null ? (value as Record_) : undefined

const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined
  if (!Array.isArray(content)) return
  const blocks = content.flatMap((block) => {
    const item = asRecord(block)
    if (!item) return []
    if (item.type !== "text") return []
    const text = asString(item.text)
    return text ? [text] : []
  })
  if (!blocks.length) return
  return blocks.join("\n\n")
}

const TITLE_LIMIT = 80

export function parseClaudeCode(input: { readonly path: string; readonly text: string }): ParsedSession {
  let sessionID = ""
  let cwd = ""
  let lastTime = 0
  const messages: ImportedMessage[] = []

  for (const raw of input.text.split("\n")) {
    if (!raw.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    if (!record) continue
    if (record.isSidechain === true) continue
    const type = record.type
    if (type !== "user" && type !== "assistant") continue
    const message = asRecord(record.message)
    if (!message) continue
    const text = textOf(message.content)
    if (!text) continue

    if (!sessionID) sessionID = asString(record.sessionId) ?? ""
    if (!cwd) cwd = asString(record.cwd) ?? ""
    const stamp = asString(record.timestamp)
    const parsedTime = stamp ? Date.parse(stamp) : Number.NaN
    const time = Number.isFinite(parsedTime) ? parsedTime : lastTime
    lastTime = time
    messages.push({ role: type, text, time })
  }

  const firstUser = messages.find((message) => message.role === "user")
  const fallback = input.path.split("/").at(-2) ?? input.path
  const title = (firstUser?.text ?? fallback).slice(0, TITLE_LIMIT)

  return {
    sourceSessionID: sessionID || input.path,
    sourcePath: input.path,
    cwd,
    title,
    messages,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/import-claude-code.test.ts` (from `packages/plugin`)
Expected: PASS for all five tests.

- [ ] **Step 5: Typecheck and commit**

Run: `bun typecheck` (from `packages/plugin`), expect no errors.

```bash
git add packages/plugin/src/import packages/plugin/test/import-claude-code.test.ts
git commit -m "feat(plugin): add claude code transcript parser"
```

---

### Task 8: Codex parser

**Files:**
- Create: `packages/plugin/src/import/codex.ts`
- Test: `packages/plugin/test/import-codex.test.ts`

**Interfaces:**
- Consumes: `ImportedMessage`, `ParsedSession` from `./types`.
- Produces: `export const parseCodex = (input: { readonly path: string; readonly text: string }) => ParsedSession`

- [ ] **Step 1: Write the failing test**

Create `packages/plugin/test/import-codex.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { parseCodex } from "../src/import/codex"

const line = (value: unknown) => JSON.stringify(value)

const fixture = [
  line({
    type: "session_meta",
    payload: { id: "01abc", session_id: "01abc", cwd: "/repo", timestamp: "2026-01-01T00:00:00.000Z" },
  }),
  line({ type: "event_msg", payload: { type: "user_message", message: "Do the thing" } }),
  line({ type: "response_item", payload: { type: "reasoning", summary: "thinking" } }),
  line({ type: "event_msg", payload: { type: "agent_message", phase: "final", message: "Done." } }),
  line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
  line({ type: "event_msg", payload: { type: "token_count", info: {} } }),
].join("\n")

describe("parseCodex", () => {
  it("reads session metadata", () => {
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text: fixture })
    expect(parsed.sourceSessionID).toBe("01abc")
    expect(parsed.cwd).toBe("/repo")
  })

  it("keeps user and assistant messages in order", () => {
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text: fixture })
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(parsed.messages[0]?.text).toBe("Do the thing")
  })

  it("dedupes assistant text mirrored across event_msg and response_item", () => {
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text: fixture })
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[1]?.text).toBe("Done.")
  })

  it("ignores reasoning and token_count records", () => {
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text: fixture })
    expect(parsed.messages.some((message) => message.text === "thinking")).toBe(false)
  })

  it("derives a title from the first user message", () => {
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text: fixture })
    expect(parsed.title).toBe("Do the thing")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/import-codex.test.ts` (from `packages/plugin`)
Expected: FAIL with "Cannot find module" for `../src/import/codex`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/plugin/src/import/codex.ts`:

```ts
import type { ImportedMessage, ParsedSession } from "./types"

type Record_ = Record<string, unknown>

const asRecord = (value: unknown): Record_ | undefined =>
  typeof value === "object" && value !== null ? (value as Record_) : undefined

const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

function responseText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined
  if (!Array.isArray(content)) return
  const blocks = content.flatMap((block) => {
    const item = asRecord(block)
    if (!item) return []
    if (item.type !== "output_text" && item.type !== "text") return []
    const text = asString(item.text)
    return text ? [text] : []
  })
  if (!blocks.length) return
  return blocks.join("\n\n")
}

const TITLE_LIMIT = 80
const normalize = (value: string) => value.replace(/\s+/g, " ").trim()

export function parseCodex(input: { readonly path: string; readonly text: string }): ParsedSession {
  let sessionID = ""
  let cwd = ""
  let time = 0
  const messages: ImportedMessage[] = []

  const push = (role: ImportedMessage["role"], text: string) => {
    const previous = messages.at(-1)
    if (role === "assistant" && previous?.role === "assistant" && normalize(previous.text) === normalize(text)) return
    messages.push({ role, text, time })
  }

  for (const raw of input.text.split("\n")) {
    if (!raw.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    if (!record) continue
    const payload = asRecord(record.payload)
    if (!payload) continue
    const stamp = asString(record.timestamp)
    const parsedTime = stamp ? Date.parse(stamp) : Number.NaN
    if (Number.isFinite(parsedTime)) time = parsedTime

    if (record.type === "session_meta") {
      sessionID = asString(payload.id) ?? asString(payload.session_id) ?? ""
      cwd = asString(payload.cwd) ?? ""
      continue
    }

    if (record.type === "event_msg") {
      if (payload.type === "user_message") {
        const text = asString(payload.message)
        if (text?.trim()) push("user", text)
        continue
      }
      if (payload.type === "agent_message" && payload.phase === "final") {
        const text = asString(payload.message)
        if (text?.trim()) push("assistant", text)
        continue
      }
      continue
    }

    if (record.type === "response_item" && payload.type === "message") {
      const role = asString(payload.role)
      if (role !== "user" && role !== "assistant") continue
      const text = responseText(payload.content)
      if (!text) continue
      push(role, text)
    }
  }

  const firstUser = messages.find((message) => message.role === "user")
  const title = (firstUser?.text ?? input.path.split("/").at(-1) ?? input.path).slice(0, TITLE_LIMIT)

  return {
    sourceSessionID: sessionID || input.path,
    sourcePath: input.path,
    cwd,
    title,
    messages,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/import-codex.test.ts` (from `packages/plugin`)
Expected: PASS for all five tests.

- [ ] **Step 5: Typecheck and commit**

Run: `bun typecheck` (from `packages/plugin`), expect no errors.

```bash
git add packages/plugin/src/import/codex.ts packages/plugin/test/import-codex.test.ts
git commit -m "feat(plugin): add codex transcript parser"
```

---

### Task 9: Source discovery

**Files:**
- Create: `packages/plugin/src/import/discover.ts`
- Test: `packages/plugin/test/import-discover.test.ts`

**Interfaces:**
- Consumes: `ImportSource`, `ParsedSession` from `./types`; the parsers from Tasks 7 and 8.
- Produces:
  ```ts
  export type SourceCandidate = {
    readonly path: string
    readonly source: ImportSource
    readonly sourceSessionID: string
    readonly title: string
    readonly cwd: string
    readonly time: number
    readonly messageCount: number
  }
  export const discover = (input: {
    readonly source: ImportSource
    readonly home: string
    readonly read: (path: string) => Promise<string | undefined>
    readonly list: (dir: string) => Promise<ReadonlyArray<string>>
  }) => Promise<ReadonlyArray<SourceCandidate>>
  ```

The `read` and `list` functions are injected so discovery is testable without touching the real
filesystem.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin/test/import-discover.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { discover } from "../src/import/discover"

const files: Record<string, string> = {
  "/home/u/.claude/projects/-work/aaa.jsonl": [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "aaa",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "First prompt" },
    }),
  ].join("\n"),
  "/home/u/.claude/projects/-work/notes.txt": "ignore me",
}

const dirs: Record<string, string[]> = {
  "/home/u/.claude/projects": ["/home/u/.claude/projects/-work"],
  "/home/u/.claude/projects/-work": [
    "/home/u/.claude/projects/-work/aaa.jsonl",
    "/home/u/.claude/projects/-work/notes.txt",
  ],
}

describe("discover", () => {
  it("lists claude code sessions with titles and counts", async () => {
    const found = await discover({
      source: "claude-code",
      home: "/home/u",
      read: async (path) => files[path],
      list: async (dir) => dirs[dir] ?? [],
    })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      source: "claude-code",
      sourceSessionID: "aaa",
      title: "First prompt",
      cwd: "/work",
      messageCount: 1,
    })
  })

  it("returns an empty list when the source root is missing", async () => {
    const found = await discover({
      source: "claude-code",
      home: "/home/u",
      read: async () => undefined,
      list: async (dir) => dirs[dir] ?? [],
    })
    expect(found.filter((item) => item.sourceSessionID === "aaa")).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/import-discover.test.ts` (from `packages/plugin`)
Expected: FAIL with "Cannot find module" for `../src/import/discover`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/plugin/src/import/discover.ts`:

```ts
import path from "path"
import { parseClaudeCode } from "./claude-code"
import { parseCodex } from "./codex"
import type { ImportSource, ParsedSession } from "./types"

export type SourceCandidate = {
  readonly path: string
  readonly source: ImportSource
  readonly sourceSessionID: string
  readonly title: string
  readonly cwd: string
  readonly time: number
  readonly messageCount: number
}

type DiscoverInput = {
  readonly source: ImportSource
  readonly home: string
  readonly read: (path: string) => Promise<string | undefined>
  readonly list: (dir: string) => Promise<ReadonlyArray<string>>
}

async function collectFiles(list: DiscoverInput["list"], root: string, match: (file: string) => boolean) {
  const found: string[] = []
  const queue = [root]
  while (queue.length) {
    const dir = queue.shift()
    if (!dir) continue
    for (const entry of await list(dir)) {
      if (match(entry)) {
        found.push(entry)
        continue
      }
      if (!path.extname(entry)) queue.push(entry)
    }
  }
  return found
}

const candidate = (source: ImportSource, parsed: ParsedSession): SourceCandidate => {
  const first = parsed.messages[0]
  return {
    path: parsed.sourcePath,
    source,
    sourceSessionID: parsed.sourceSessionID,
    title: parsed.title,
    cwd: parsed.cwd,
    time: first?.time ?? 0,
    messageCount: parsed.messages.length,
  }
}

export async function discover(input: DiscoverInput): Promise<ReadonlyArray<SourceCandidate>> {
  const root =
    input.source === "claude-code"
      ? path.join(input.home, ".claude", "projects")
      : path.join(input.home, ".codex", "sessions")

  const files = await collectFiles(list, root, (file) => path.extname(file) === ".jsonl")
  const out: SourceCandidate[] = []
  for (const file of files) {
    const text = await input.read(file)
    if (text === undefined) continue
    const parsed = input.source === "claude-code" ? parseClaudeCode({ path: file, text }) : parseCodex({ path: file, text })
    if (!parsed.messages.length) continue
    out.push(candidate(input.source, parsed))
  }
  return out.sort((a, b) => b.time - a.time)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/import-discover.test.ts` (from `packages/plugin`)
Expected: PASS for both tests.

- [ ] **Step 5: Typecheck and commit**

Run: `bun typecheck` (from `packages/plugin`), expect no errors.

```bash
git add packages/plugin/src/import/discover.ts packages/plugin/test/import-discover.test.ts
git commit -m "feat(plugin): add transcript source discovery"
```

---

### Task 10: Import TUI plugin

**Files:**
- Create: `packages/plugin/src/import/tui.tsx`
- Modify: `packages/plugin/package.json` (add a `./tui-import` export and the `@opentui/solid` peer)
- Test: `packages/plugin/test/import-tui.test.ts`

**Interfaces:**
- Consumes: `TuiPluginApi`, `TuiPluginModule` from `@opencode-ai/plugin/tui`; `discover`, `SourceCandidate` from `./discover`; the parsers; `ParsedSession` from `./types`.
- Produces: `export const ImportTuiPlugin: TuiPluginModule` with `id: "opencode-session-import"`, a `tui` function, and a route named `session-import`.

- [ ] **Step 1: Write the failing test for the pure selection logic**

Extract the selection and dedupe decisions into a pure function so they are testable without rendering. Create `packages/plugin/test/import-tui.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { buildOptions, toggleSelection } from "../src/import/selection"
import type { SourceCandidate } from "../src/import/discover"

const candidate = (id: string): SourceCandidate => ({
  path: `/tmp/${id}.jsonl`,
  source: "codex",
  sourceSessionID: id,
  title: `title ${id}`,
  cwd: "/work",
  time: 1,
  messageCount: 2,
})

describe("import selection", () => {
  it("toggles membership", () => {
    const first = toggleSelection(new Set<string>(), "a")
    expect([...first]).toEqual(["a"])
    const second = toggleSelection(first, "a")
    expect([...second]).toEqual([])
  })

  it("marks already imported sessions as disabled", () => {
    const options = buildOptions([candidate("a"), candidate("b")], new Set(["a"]))
    expect(options.map((option) => option.disabled)).toEqual([true, false])
  })

  it("exposes the candidate on each option", () => {
    const options = buildOptions([candidate("a")], new Set())
    expect(options[0]?.value).toMatchObject({ sourceSessionID: "a" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/import-tui.test.ts` (from `packages/plugin`)
Expected: FAIL with "Cannot find module" for `../src/import/selection`.

- [ ] **Step 3: Write the pure selection module**

Create `packages/plugin/src/import/selection.ts`:

```ts
import type { SourceCandidate } from "./discover"

export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export type SelectionOption = {
  readonly title: string
  readonly description: string
  readonly value: SourceCandidate
  readonly disabled: boolean
}

export function buildOptions(
  candidates: ReadonlyArray<SourceCandidate>,
  imported: ReadonlySet<string>,
): ReadonlyArray<SelectionOption> {
  return candidates.map((item) => ({
    title: item.title,
    description: `${item.messageCount} messages · ${item.cwd}`,
    value: item,
    disabled: imported.has(item.sourceSessionID),
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/import-tui.test.ts` (from `packages/plugin`)
Expected: PASS for all three tests.

- [ ] **Step 5: Write the TUI plugin**

Create `packages/plugin/src/import/tui.tsx`:

```tsx
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import os from "os"
import path from "path"
import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { parseClaudeCode } from "./claude-code"
import { parseCodex } from "./codex"
import { discover, type SourceCandidate } from "./discover"
import { buildOptions, toggleSelection } from "./selection"
import type { ImportSource, ParsedSession } from "./types"

const sourceLabel = (source: ImportSource) => (source === "claude-code" ? "Claude Code" : "Codex")

async function listDir(dir: string) {
  const glob = new Bun.Glob("*")
  const out: string[] = []
  for await (const entry of glob.scan({ cwd: dir, onlyFiles: false })) out.push(path.join(dir, entry))
  return out
}

async function readFile(file: string) {
  const handle = Bun.file(file)
  if (!(await handle.exists())) return
  return handle.text()
}

function ImportFlow(props: { api: TuiPluginApi }) {
  const [source, setSource] = createSignal<ImportSource | undefined>()
  const [target, setTarget] = createSignal<string | undefined>()
  const [candidates, setCandidates] = createSignal<ReadonlyArray<SourceCandidate>>([])
  const [imported, setImported] = createSignal<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = createSignal(false)
  const [status, setStatus] = createSignal("")

  const options = createMemo(() => buildOptions(candidates(), imported()))

  async function load(input: { source: ImportSource; directory: string }) {
    setBusy(true)
    setStatus("Scanning…")
    const found = await discover({ source: input.source, home: os.homedir(), read: readFile, list: listDir })
    const response = await props.api.client.v2.import.imported({ source: input.source, directory: input.directory })
    const known = new Set((response.data?.data ?? []).map((item) => item.sourceSessionID))
    setCandidates(found)
    setImported(known)
    setSelected(new Set())
    setBusy(false)
    setStatus(`${found.length} sessions found`)
  }

  async function run() {
    const directory = target()
    const current = source()
    if (!directory || !current) return
    setBusy(true)
    let ok = 0
    let failed = 0
    for (const candidate of candidates().filter((item) => selected().has(item.sourceSessionID))) {
      const text = await readFile(candidate.path)
      if (text === undefined) {
        failed += 1
        continue
      }
      const parsed: ParsedSession =
        candidate.source === "claude-code" ? parseClaudeCode({ path: candidate.path, text }) : parseCodex({ path: candidate.path, text })
      try {
        await props.api.client.v2.import.session({
          source: candidate.source,
          sourceSessionID: candidate.sourceSessionID,
          sourcePath: candidate.path,
          title: candidate.title,
          location: { directory },
          transcript: parsed.messages,
        })
        ok += 1
      } catch {
        failed += 1
      }
    }
    setBusy(false)
    props.api.ui.toast({ variant: failed ? "error" : "info", message: `Imported ${ok}, failed ${failed}` })
    props.api.ui.dialog.clear()
  }

  return (
    <Show when={target()} fallback={<TargetPicker api={props.api} onPick={setTarget} />}>
      <Show when={source()} fallback={<SourcePicker api={props.api} onPick={setSource} />}>
        <props.api.ui.DialogSelect<string>
          title={`Import from ${sourceLabel(source()!)}`}
          placeholder="Space to toggle, Enter to import"
          options={options().map((option) => ({
            title: `${selected().has(option.value.sourceSessionID) ? "[x] " : "[ ] "}${option.title}`,
            description: option.description,
            value: option.value.sourceSessionID,
            disabled: option.disabled,
          }))}
          onSelect={(option) => {
            setSelected(toggleSelection(selected(), option.value))
          }}
        />
        <text>{busy() ? status() : status()}</text>
      </Show>
    </Show>
  )
}

function SourcePicker(props: { api: TuiPluginApi; onPick: (source: ImportSource) => void }) {
  return (
    <props.api.ui.DialogSelect<ImportSource>
      title="Import source"
      options={[
        { title: "Claude Code", value: "claude-code" },
        { title: "Codex", value: "codex" },
      ]}
      onSelect={(option) => props.onPick(option.value)}
    />
  )
}

function TargetPicker(props: { api: TuiPluginApi; onPick: (directory: string) => void }) {
  const [projects, setProjects] = createSignal<ReadonlyArray<{ id: string; directory: string }>>([])

  createEffect(() => {
    void props.api.client.project
      .list()
      .then((response) => {
        const raw = (response.data ?? []) as ReadonlyArray<{ id?: string; worktree?: string; directory?: string }>
        setProjects(
          raw.flatMap((project) => {
            const directory = project.directory ?? project.worktree
            if (!directory) return []
            return [{ id: project.id ?? directory, directory }]
          }),
        )
      })
      .catch(() => setProjects([]))
  })

  return (
    <props.api.ui.DialogSelect<string>
      title="Target project directory"
      options={[
        { title: `${process.cwd()} (current)`, value: process.cwd() },
        ...projects()
          .filter((project) => project.directory !== process.cwd())
          .map((project) => ({ title: project.directory, value: project.directory })),
      ]}
      onSelect={(option) => props.onPick(option.value)}
    />
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: "session-import",
      render: () => <ImportFlow api={api} />,
    },
  ])
  api.keymap.registerLayer({
    commands: [
      {
        name: "session-import.open",
        title: "Import sessions",
        category: "Session",
        run() {
          api.route.navigate("session-import")
        },
      },
    ],
    bindings: [{ key: "ctrl+shift+i", cmd: "session-import.open", desc: "Import sessions" }],
  })
}

export const ImportTuiPlugin: TuiPluginModule = {
  id: "opencode-session-import",
  tui,
}
```

Command and binding shapes are verified against
`packages/tui/src/feature-plugins/system/plugins.tsx:239-262`: commands take
`{ name, title, category, run() }`, bindings take `{ key, cmd, desc }`. Note that
`client.project.list()` returns the V2 project shape (`packages/sdk/js/src/v2/gen/sdk.gen.ts:2530`);
read `directory` and fall back to `worktree`, and guard against a missing field rather than
trusting a single property name.

- [ ] **Step 6: Add the package export**

In `packages/plugin/package.json`, add to `exports`:

```json
"./tui-import": "./src/import/tui.tsx"
```

`@opentui/solid` is already in `peerDependencies`. Import it only in this file so the base package
stays UI-free.

- [ ] **Step 7: Typecheck and commit**

Run: `bun typecheck` (from `packages/plugin`), expect no errors beyond the SDK surface from Task 6. If `client.v2.import` does not exist, revisit Task 6 before continuing.

```bash
git add packages/plugin/src/import packages/plugin/package.json packages/plugin/test/import-tui.test.ts
git commit -m "feat(plugin): add session import tui plugin"
```

---

### Task 11: Documentation and end-to-end verification

**Files:**
- Create: `packages/plugin/README-session-import.md`
- Modify: `docs/superpowers/specs/2026-09-17-session-import-design.md` (mark Status: Implemented)

**Interfaces:**
- Consumes: everything from Tasks 1-10.
- Produces: user-facing install instructions and a recorded end-to-end result.

- [ ] **Step 1: Write the README**

Document how to enable the plugin in `opencode.json` using the local package spec, the default
keybind, and the exact source directories read (`~/.claude/projects`, `~/.codex/sessions`).

- [ ] **Step 2: Run the full test set**

Run each from its package directory:

```bash
cd packages/core && bun test test/session-import.test.ts test/session-import-registry.test.ts
cd packages/protocol && bun test test/import-group.test.ts
cd packages/plugin && bun test test/import-claude-code.test.ts test/import-codex.test.ts test/import-discover.test.ts test/import-tui.test.ts
```

Expected: all pass.

- [ ] **Step 3: Verify against real data**

Start the TUI in tmux and run the import command against this machine's real
`~/.claude/projects` and `~/.codex/sessions`, then confirm an imported session shows the messages in
both the TUI session view and the app timeline.

```bash
tmux new-session -d -s opencode-dev 'bun dev'
tmux capture-pane -pt opencode-dev
tmux kill-session -t opencode-dev
```

Record the observed result in the spec. If the app timeline does not show imported messages, the V2
dual-write in Task 1 is wrong; fix it before marking the task complete.

- [ ] **Step 4: Typecheck everything touched**

Run `bun typecheck` from `packages/core`, `packages/protocol`, `packages/server`, `packages/plugin`,
`packages/sdk/js`.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/README-session-import.md docs/superpowers/specs/2026-09-17-session-import-design.md
git commit -m "docs: document session import plugin"
```

---

## Self-Review Notes

**Spec coverage:** Every in-scope spec item maps to a task. TUI plugin and picker (Task 10),
project picker defaulting to current project (Task 10 `TargetPicker`), Claude Code mapping (Task 7),
Codex mapping with dedupe (Task 8), core dual-projection write (Task 1), the create-time metadata
threading that makes provenance possible (Task 2), the end-to-end operation (Task 4), protocol and
server routes (Tasks 3 and 5), provenance and skip-on-reimport dedupe (Tasks 2 and 10), per-session
error isolation (Task 10 `run`), deterministic IDs (Task 1 `messageID(ordinal)`), and time ordering
(Tasks 7-9).

**Deliberate design decisions recorded during planning:**

- **V2 `Session.Info` has no `metadata` field** (`packages/schema/src/session.ts:21-45`). Only V1
  `SessionInfo` does. Provenance therefore flows through the V1 `SessionInfo` that `SessionV2.create`
  already fabricates (`packages/core/src/session.ts:207-236`), which the projector writes to
  `SessionTable.metadata` (`packages/core/src/session/projector.ts:61`). Task 2 extends `create` with
  an optional `metadata` input; no schema change is required.
- **The import operation lives in core, not the server handler** (Task 4). This keeps the server a
  thin adapter and lets the full create-stamp-write behavior be tested without HTTP. Task 5's test
  guards the route surface only.
- **Task 10 re-scans to parse instead of caching parsed transcripts** at discovery time. Discovery
  reads every file to build titles and counts anyway, but re-reading at import keeps memory bounded
  and the code simpler. If discovery becomes slow on large histories, cache the parse result on
  `SourceCandidate` as a follow-up.
- **Task 1 uses deterministic ordinal-based IDs** derived from transcript position. IDs are stable
  across re-imports, which is what the dedupe design depends on. The core service is single-use per
  session; the endpoint never reuses a session, so collisions cannot occur.

**Out of scope, confirmed:** tool calls, thinking blocks, sidechains, attachments, in-place update,
desktop app UI, and external CLI sub-agents.
