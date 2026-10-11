# WS14 Knowledge Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cowork-style knowledge-work home to Flynncode where one coherent Home lists code and knowledge sessions together and starts folder-scoped non-coding sessions backed by per-project knowledge files with local-only execution.

**Architecture:** File-backed project knowledge under `.opencode/knowledge/` plus a new native primary `knowledge` agent with docs-write-only permissions; Home and New Session views gain a session-kind switch that selects the agent and folder scope without forking routes or lists; all execution stays local via existing SessionRunner and Location placement.

**Tech Stack:** Bun + TypeScript monorepo, SolidJS app (`packages/app`), Effect services (`packages/flynncode/src`), Drizzle/SQLite via `@opencode-ai/core`, typed i18n keys in `packages/app/src/i18n/en.ts`.

## Global Constraints

- Backends self-hosted or user-owned only; vendor-hosted clouds, Sites hosting, and voice products stay OUT.
- Local execution only; no cloud session placement, no cloud environment images, no hosted push relay.
- UI copy via i18n keys (en only), never hardcode user-visible English in production code.
- No `any` type in new or edited TypeScript.
- No star imports and no aliased imports; import the module's own exported namespace by name where namespacing is needed.
- Keep runtime dependencies directed from Schema to Core and Protocol, then Core and Protocol to Server; Client runtime depends on Schema and Protocol but never Core or Server.
- Do not edit `packages/client/src/generated` or `src/generated-effect` directly; after Protocol or Server HttpApi changes run `bun run generate` from `packages/client`.
- After changing public Protocol or Server HttpApi, run `bun run generate` from `packages/client`.
- Run `bun typecheck` from package directories (e.g. `packages/flynncode`, `packages/app`), never `tsc` directly.
- Run tests from package dirs like `packages/flynncode`, never from repo root.
- Branch name max three words hyphen-separated, no slashes or type prefixes; default branch is `dev`.
- Commits and PR titles use conventional style: `type(scope): summary` with types `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Follow SolidJS rule: prefer `createStore` over multiple `createSignal` calls in app code.
- In Effect generators, bind services to named variables before calling methods; never use nested yields like `yield* (yield* Foo.Service).bar()`.
- Do not fork-then-remerge chat and work: one coherent Home list and one New Session composer with a kind switch, not separate routes.
- One coherent home: filter chips, not separate pages, for code versus knowledge sessions.

---

## File Map

**Backend — knowledge store (new):**

- Create: `packages/flynncode/src/knowledge/knowledge.ts` — Effect service `Knowledge` with file-backed CRUD for `<worktree>/.opencode/knowledge/<slug>.md`, slug validation, frontmatter title parsing, list/get/save/remove scoped to session directory.
- Create: `packages/flynncode/src/knowledge/knowledge.test.ts` — service tests against temp dirs using real filesystem, no mocks.
- Modify: `packages/flynncode/src/project/bootstrap.ts` — register knowledge service init if the bootstrap file lists per-service inits (verify exact export names before editing).

**Backend — knowledge agent (extend existing):**

- Modify: `packages/flynncode/src/agent/agent.ts:140-265` — add native primary `knowledge` agent entry alongside `build`/`plan` with docs-write-only permissions and description for non-coding knowledge work.
- Create: `packages/flynncode/src/agent/prompt/knowledge.txt` — system prompt for the knowledge agent (folder-scoped research, summarize, draft docs, no code edits, cite sources).
- Modify: `packages/flynncode/src/agent/agent.ts:11-16` — add static import for the new prompt text file following existing `PROMPT_EXPLORE` pattern.

**Backend — session kind wiring (extend existing):**

- Modify: `packages/flynncode/src/session/session.ts` — only if a durable `kind` column is needed; preferred approach is no schema change: knowledge sessions are sessions whose `agent` is `knowledge`. Inspect this file first; if agent name already persists on the session row, do not add a column.
- Modify: `packages/flynncode/src/config/agent.ts` — no change expected; verify `load`/`loadMode` already surfaces the native `knowledge` agent without config entries.

**Frontend — Home coherent list:**

- Modify: `packages/app/src/pages/home.tsx:11-50` — pass kind-filter state from sessions controller into `HomeSessions`; no new route.
- Modify: `packages/app/src/pages/home/home-sessions-controller.tsx` — add `kindFilter` store (`all` | `code` | `knowledge`) plus filtered groups memo and `setKindFilter` action; knowledge identity is `session.agent === "knowledge"`.
- Modify: `packages/app/src/pages/home/home-sessions-view.tsx:224,253,682-704` — add filter chips row above the list and a kind badge on session rows; all copy via new i18n keys.
- Modify: `packages/app/src/pages/home/home-controller.ts:49-117` — extend `openProjectNewSession` to accept an optional session-kind argument that seeds the draft tab (agent `knowledge` when kind is knowledge).
- Modify: `packages/app/src/pages/home/home-projects-view.tsx:548-581` — add "New knowledge session" menu item alongside existing "New session" item per project row.

**Frontend — New Session composer:**

- Modify: `packages/app/src/pages/new-session/new-session-view.tsx:34-87` — add kind selector (Code / Knowledge) above composer that drives default agent and helper copy; keep single `NewSessionView` component.
- Modify: `packages/app/src/pages/new-session/new-session-draft-controller.ts:18-88` — add `kind` store with `setKind` that syncs `local.agent` between `build` and `knowledge`; expose `kind` to the view.
- Modify: `packages/app/src/pages/new-session/new-session-workspace-controller.ts` — verify extra-folders plumbing already supports folder-scoped knowledge sessions; add knowledge hint copy only, no structural change (read file first).
- Modify: `packages/app/src/components/prompt-project-selector.tsx:138-141` — no structural change; confirm project selector works for knowledge folders (non-git directories allowed via existing initGit fallback in `home-controller.ts:89-109`).

**Frontend — i18n (en only):**

- Modify: `packages/app/src/i18n/en.ts` — append keys listed in Task 1 interfaces; do not touch other locale files (translation pipeline handles them).

---

## Interfaces

**Knowledge service (`packages/flynncode/src/knowledge/knowledge.ts`):**

```ts
import { Knowledge } from "@/knowledge/knowledge"

const entries = yield* Knowledge.Service.list({ worktree: "/home/user/notes" })
// entries: Array<{ slug: string; title: string; path: string; updated: number }>

const entry = yield* Knowledge.Service.get({ worktree: "/home/user/notes", slug: "onboarding" })
// entry: { slug: string; title: string; body: string; path: string } | undefined

yield* Knowledge.Service.save({ worktree: "/home/user/notes", slug: "onboarding", title: "Onboarding", body: "# Onboarding\n..." })
// returns { slug: string; path: string }

yield* Knowledge.Service.remove({ worktree: "/home/user/notes", slug: "stale-note" })
// returns void; removing a missing slug is a no-op
```

Slug rule: `^[a-z0-9][a-z0-9-]{0,63}$`. Invalid slug fails with `Knowledge.InvalidSlugError` (a `Schema.TaggedErrorClass`). File layout: `<worktree>/.opencode/knowledge/<slug>.md` with body `---\ntitle: <title>\n---\n<markdown>`. List sorts by `updated` (file mtime) descending. All methods take explicit `worktree` string; no ambient instance context.

Consumes: `FileSystem.FileSystem` for file I/O, `Path.Path` for joins, `Effect` for composition.
Produces: `Knowledge.Service` with `list`, `get`, `save`, `remove` used by Task 4 system-prompt injection and future knowledge UI.

**Knowledge agent (`packages/flynncode/src/agent/agent.ts` addition):**

```ts
knowledge: {
  name: "knowledge",
  description: "Non-coding knowledge work. Researches folders, summarizes documents, drafts notes. Reads broadly, writes markdown docs only, never edits code.",
  mode: "primary",
  native: true,
  prompt: PROMPT_KNOWLEDGE,
  permission: Permission.merge(defaults, Permission.fromConfig({ ... }), user),
  options: {},
}
```

Permission ruleset (exact):

```ts
Permission.fromConfig({
  question: "allow",
  edit: {
    "*": "deny",
    "*.md": "allow",
    "*.mdx": "allow",
    "*.txt": "allow",
    "*.markdown": "allow",
  },
  write: {
    "*": "deny",
    "*.md": "allow",
    "*.mdx": "allow",
    "*.txt": "allow",
    "*.markdown": "allow",
  },
  bash: { "*": "ask" },
  webfetch: "allow",
  websearch: "allow",
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
  external_directory: readonlyExternalDirectory,
})
```

Consumes: existing `defaults`, `readonlyExternalDirectory`, `user` locals in `Agent.state`.
Produces: `knowledge` entry in `Agent.list()` and selectable primary agent in session-new model picker.

**Home kind filter (`home-sessions-controller.tsx` addition):**

```ts
const store = createStore<{ kindFilter: "all" | "code" | "knowledge" }>({ kindFilter: "all" })
function setKindFilter(next: "all" | "code" | "knowledge") { ... }
const filteredGroups = createMemo(() => filterGroups(sessions.data.groups(), store.kindFilter))
```

Knowledge identity: `session.agent === "knowledge"`. Code identity: any other agent value. Filter defaults to `all`.

Consumes: existing `sessions.data.groups()` shape.
Produces: `kindFilter`, `setKindFilter`, `filteredGroups` consumed by `home-sessions-view.tsx` chips and list.

**New session kind (`new-session-draft-controller.ts` addition):**

```ts
const draftStore = createStore<{ kind: "code" | "knowledge" }>({ kind: "code" })
function setKind(next: "code" | "knowledge") {
  // sets draftStore.kind and syncs local.agent to "knowledge" or "build"
}
```

Consumes: `useLocal()` agent setter.
Produces: `kind` accessor + `setKind` action consumed by `NewSessionView` kind selector.

**i18n keys (append to `packages/app/src/i18n/en.ts` dict, en only):**

```ts
"home.filter.all": "All",
"home.filter.code": "Code",
"home.filter.knowledge": "Knowledge",
"home.knowledge.badge": "Knowledge",
"home.project.newKnowledgeSession": "New knowledge session",
"session.new.kind.label": "Session type",
"session.new.kind.code": "Code",
"session.new.kind.knowledge": "Knowledge",
"session.new.kind.knowledgeHint": "Research folders and draft docs. Edits stay in markdown.",
"knowledge.empty.title": "No knowledge yet",
"knowledge.empty.description": "Add a markdown note in .opencode/knowledge to ground this project.",
"knowledge.folders.hint": "These folders scope what the knowledge session can read and write.",
```

---

### Task 1: Append knowledge-home i18n keys

**Files:**
- Modify: `packages/app/src/i18n/en.ts`
- Test: `packages/app/src/i18n/en.test.ts` (create only if an i18n dict test file already exists; otherwise verify via typecheck step below)

**Interfaces:**
- Consumes: existing `dict` export shape in `en.ts`.
- Produces: 12 new keys listed in Interfaces above for Tasks 3 and 5.

- [ ] **Step 1: Read the tail of the dict to find the insertion point**

Read: `packages/app/src/i18n/en.ts` offset 1650 to end. Note the final entries and trailing comma style. Do not copy unrelated keys.

- [ ] **Step 2: Add the 12 keys verbatim**

Edit `packages/app/src/i18n/en.ts`, inserting after the last `"settings.import.*"` entry (around line 1688), keeping alphabetical-ish grouping used by neighbors where obvious but preserving exact key strings and English values from the Interfaces block above:

```ts
"home.filter.all": "All",
"home.filter.code": "Code",
"home.filter.knowledge": "Knowledge",
"home.knowledge.badge": "Knowledge",
"home.project.newKnowledgeSession": "New knowledge session",
"session.new.kind.label": "Session type",
"session.new.kind.code": "Code",
"session.new.kind.knowledge": "Knowledge",
"session.new.kind.knowledgeHint": "Research folders and draft docs. Edits stay in markdown.",
"knowledge.empty.title": "No knowledge yet",
"knowledge.empty.description": "Add a markdown note in .opencode/knowledge to ground this project.",
"knowledge.folders.hint": "These folders scope what the knowledge session can read and write.",
```

- [ ] **Step 3: Typecheck the app package**

Run: `bun typecheck` with `workdir` `packages/app`
Expected: PASS with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/i18n/en.ts
git commit -m "feat(app): add knowledge-home i18n keys"
```

---

### Task 2: Create knowledge agent prompt plus registration

**Files:**
- Create: `packages/flynncode/src/agent/prompt/knowledge.txt`
- Modify: `packages/flynncode/src/agent/agent.ts`
- Test: `packages/flynncode/test/agent/knowledge-agent.test.ts` (create; check `packages/flynncode/test` layout first and mirror the closest agent test path if different)

**Interfaces:**
- Consumes: `PROMPT_EXPLORE` static-text import pattern, `defaults` / `readonlyExternalDirectory` / `user` locals, `Permission.merge`, `Permission.fromConfig`.
- Produces: native primary `knowledge` agent visible in `Agent.list()` with docs-write-only permissions.

- [ ] **Step 1: Write the failing test**

Create `packages/flynncode/test/agent/knowledge-agent.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { makeTestRuntime } from "../helpers/runtime"

describe("knowledge agent", () => {
  test("lists a primary knowledge agent with docs-only write", async () => {
    const runtime = makeTestRuntime()
    const agents = await runtime.runPromise(Effect.gen(function* () {
      const agent = yield* Agent.Service
      return yield* agent.list()
    }))
    const knowledge = agents.find((item) => item.name === "knowledge")
    expect(knowledge).toBeDefined()
    expect(knowledge?.mode).toBe("primary")
    expect(knowledge?.native).toBe(true)
  })
})
```

If `makeTestRuntime` does not exist at that path, read the nearest existing agent or permission test and use its exact runtime helper name instead; keep the two assertions identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/agent/knowledge-agent.test.ts` with `workdir` `packages/flynncode`
Expected: FAIL with knowledge agent undefined.

- [ ] **Step 3: Create the prompt file**

Create `packages/flynncode/src/agent/prompt/knowledge.txt` with this exact content:

```txt
You are a knowledge-work agent for non-coding tasks. Research the folders in scope, summarize documents, and draft markdown notes.

Rules:
- Read broadly with read, glob, grep, webfetch, and websearch.
- Write only markdown-family files (.md, .mdx, .txt, .markdown). Never edit source code.
- Ask before running shell commands that modify anything; prefer read-only inspection.
- Cite which files you used in your summary.
- Keep inference and workspace on the local machine; never assume cloud placement.
```

- [ ] **Step 4: Register the agent**

In `packages/flynncode/src/agent/agent.ts`, add the static import next to `PROMPT_EXPLORE`:

```ts
import PROMPT_KNOWLEDGE from "./prompt/knowledge.txt"
```

Then add the `knowledge` entry after the `plan` entry (after line 181, before `general`), using the exact permission ruleset from the Interfaces section:

```ts
knowledge: {
  name: "knowledge",
  description: "Non-coding knowledge work. Researches folders, summarizes documents, drafts notes. Reads broadly, writes markdown docs only, never edits code.",
  options: {},
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      question: "allow",
      edit: {
        "*": "deny",
        "*.md": "allow",
        "*.mdx": "allow",
        "*.txt": "allow",
        "*.markdown": "allow",
      },
      write: {
        "*": "deny",
        "*.md": "allow",
        "*.mdx": "allow",
        "*.txt": "allow",
        "*.markdown": "allow",
      },
      bash: { "*": "ask" },
      webfetch: "allow",
      websearch: "allow",
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
      external_directory: readonlyExternalDirectory,
    }),
    user,
  ),
  mode: "primary",
  native: true,
  prompt: PROMPT_KNOWLEDGE,
},
```

Note: the file uses dot notation and no destructuring per repo style; use `Permission.merge` directly as shown. Do not alias imports.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/agent/knowledge-agent.test.ts` with `workdir` `packages/flynncode`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bun typecheck` with `workdir` `packages/flynncode`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/flynncode/src/agent/prompt/knowledge.txt packages/flynncode/src/agent/agent.ts packages/flynncode/test/agent/knowledge-agent.test.ts
git commit -m "feat(opencode): add knowledge primary agent"
```

---

### Task 3: File-backed project knowledge service

**Files:**
- Create: `packages/flynncode/src/knowledge/knowledge.ts`
- Test: `packages/flynncode/test/knowledge/knowledge.test.ts`
- Modify: `packages/flynncode/src/project/bootstrap.ts` (only if it enumerates service inits; read first and skip if init is automatic)

**Interfaces:**
- Consumes: `FileSystem.FileSystem`, `Path.Path`, `Effect`, `Schema`.
- Produces: `Knowledge.Service` with `list`/`get`/`save`/`remove` signatures from the Interfaces section.

- [ ] **Step 1: Write the failing test**

Create `packages/flynncode/test/knowledge/knowledge.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { Knowledge } from "@/knowledge/knowledge"
import { makeTestRuntime } from "../helpers/runtime"

function slugPath(worktree: string, slug: string) {
  return `${worktree}/.opencode/knowledge/${slug}.md`
}

describe("Knowledge service", () => {
  test("save then get round-trips title and body", async () => {
    const runtime = makeTestRuntime()
    const worktree = await runtime.runPromise(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      return path.join(dir, "project")
    }))
    await runtime.runPromise(
      Effect.gen(function* () {
        const knowledge = yield* Knowledge.Service
        yield* knowledge.save({ worktree, slug: "onboarding", title: "Onboarding", body: "# Onboarding\nHello" })
        const entry = yield* knowledge.get({ worktree, slug: "onboarding" })
        expect(entry?.title).toBe("Onboarding")
        expect(entry?.body).toContain("Hello")
        expect(entry?.path).toBe(slugPath(worktree, "onboarding"))
      }),
    )
  })

  test("invalid slug fails with InvalidSlugError", async () => {
    const runtime = makeTestRuntime()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const knowledge = yield* Knowledge.Service
        yield* knowledge.save({ worktree: "/tmp/knowledge-test", slug: "../escape", title: "Bad", body: "x" })
      }).pipe(Effect.flip),
    )
    expect(result._tag).toBe("Knowledge.InvalidSlugError")
  })
})
```

If the repo test helper has a different name, use the exact name from the nearest passing service test.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/knowledge/knowledge.test.ts` with `workdir` `packages/flynncode`
Expected: FAIL with module `@/knowledge/knowledge` not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/flynncode/src/knowledge/knowledge.ts` following the `export * as Knowledge from "."` self-reexport pattern used by `src/project/project.ts` and `src/foo/foo.ts` module-shape guidance. Implement `Service` as a `Context.Service`, a `layer` with `Layer.effect`, `use` via `serviceUse(Service)`, and `node` via `LayerNode.make` with deps on filesystem and path services. Implement slug validation with `Schema.TaggedErrorClass`, directory creation before save, frontmatter `title:` line parsing on get/list, mtime descending sort on list, and no-op remove on missing files. Keep helpers non-exported at file bottom. Bind yielded services to named variables (`const fs = yield* FileSystem.FileSystem`) before use. Do not return `Effect` from synchronous helpers like slug validation or frontmatter parsing.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/knowledge/knowledge.test.ts` with `workdir` `packages/flynncode`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun typecheck` with `workdir` `packages/flynncode`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/flynncode/src/knowledge/knowledge.ts packages/flynncode/test/knowledge/knowledge.test.ts
git commit -m "feat(opencode): add file-backed project knowledge service"
```

---

### Task 4: Home coherent filter plus per-project knowledge entry point

**Files:**
- Modify: `packages/app/src/pages/home/home-sessions-controller.tsx`
- Modify: `packages/app/src/pages/home/home-sessions-view.tsx`
- Modify: `packages/app/src/pages/home.tsx`
- Modify: `packages/app/src/pages/home/home-controller.ts`
- Modify: `packages/app/src/pages/home/home-projects-view.tsx`
- Test: `packages/app/src/pages/home/home-kind-filter.test.ts` (create; pure filter helper test, no mocks)

**Interfaces:**
- Consumes: Task 1 i18n keys, existing `sessions.data.groups()` and `session.agent` field, `home.project.openProjectNewSession`.
- Produces: `kindFilter` + `setKindFilter` + `filteredGroups` in the sessions controller; chips and badge in the view; `openProjectNewSession(conn, directory, kind?)` overload.

- [ ] **Step 1: Write the failing test for the filter helper**

Create `packages/app/src/pages/home/home-kind-filter.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { filterSessionsByKind } from "./home-kind-filter"

const rows = [
  { id: "a", agent: "build" },
  { id: "b", agent: "knowledge" },
  { id: "c", agent: "plan" },
]

describe("filterSessionsByKind", () => {
  test("knowledge filter keeps only knowledge agent sessions", () => {
    expect(filterSessionsByKind(rows, "knowledge").map((row) => row.id)).toEqual(["b"])
  })

  test("code filter keeps non-knowledge sessions", () => {
    expect(filterSessionsByKind(rows, "code").map((row) => row.id)).toEqual(["a", "c"])
  })

  test("all keeps everything", () => {
    expect(filterSessionsByKind(rows, "all").length).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/pages/home/home-kind-filter.test.ts` with `workdir` `packages/app`
Expected: FAIL with module `./home-kind-filter` not found.

- [ ] **Step 3: Create the helper plus controller wiring**

Create `packages/app/src/pages/home/home-kind-filter.ts` with a synchronous pure function:

```ts
export type SessionKindFilter = "all" | "code" | "knowledge"

export function filterSessionsByKind<T extends { agent?: string }>(rows: readonly T[], filter: SessionKindFilter) {
  if (filter === "all") return rows
  if (filter === "knowledge") return rows.filter((row) => row.agent === "knowledge")
  return rows.filter((row) => row.agent !== "knowledge")
}
```

Then in `home-sessions-controller.tsx`, add a `createStore<{ kindFilter: SessionKindFilter }>` with default `all`, expose `kindFilter` accessor and `setKindFilter` action, and derive `filteredGroups` by mapping each existing group through `filterSessionsByKind`. In `home.tsx`, pass `filteredGroups` instead of raw groups to `HomeSessions` and pass `kindFilter` plus `setKindFilter` through. Keep the change inside existing controller functions; do not extract single-use helpers beyond `filterSessionsByKind`.

- [ ] **Step 4: Add chips, badge, and project menu entry**

In `home-sessions-view.tsx`, render three chips above the list using `language.t("home.filter.all")`, `language.t("home.filter.code")`, `language.t("home.filter.knowledge")`, and render `language.t("home.knowledge.badge")` as a badge on rows where `session.agent === "knowledge"`. In `home-projects-view.tsx`, add a `MenuV2.Item` labeled `language.t("home.project.newKnowledgeSession")` next to the existing `command.session.new` item that calls the same `onOpenProjectNewSession` handler with kind `knowledge`. In `home-controller.ts`, extend `openProjectNewSession(conn, directory, kind?: "code" | "knowledge")` so kind `knowledge` seeds the new draft tab with agent `knowledge`; kind omitted or `code` keeps current behavior.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test src/pages/home/home-kind-filter.test.ts` with `workdir` `packages/app`
Expected: PASS.

Run: `bun typecheck` with `workdir` `packages/app`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/home/ packages/app/src/pages/home.tsx
git commit -m "feat(app): add coherent knowledge filter to home"
```

---

### Task 5: Session-new kind switch driving knowledge agent and folder scope

**Files:**
- Modify: `packages/app/src/pages/new-session/new-session-view.tsx`
- Modify: `packages/app/src/pages/new-session/new-session-draft-controller.ts`
- Test: manual UI verification plus `bun typecheck` (no new unit test; draft controller depends on router and prompt context)

**Interfaces:**
- Consumes: Task 1 keys (`session.new.kind.*`, `knowledge.folders.hint`), `useLocal()` agent state, existing `NewSessionFolders` extra-folders UI.
- Produces: kind selector in single `NewSessionView`; `kind` + `setKind` on the draft controller.

- [ ] **Step 1: Add kind store to the draft controller**

In `new-session-draft-controller.ts`, add `createStore<{ kind: "code" | "knowledge" }>` defaulting to `code` (read the `?draftKind=` search param first if present, else default `code`). Add `setKind` that updates the store and syncs `local.agent` to `knowledge` when kind is `knowledge` and back to `build` when kind is `code`. Expose `kind: () => store.kind` and `setKind` on the returned object alongside existing `input`/`prompt`/`project`. Use `createStore`, not multiple signals.

- [ ] **Step 2: Render the kind selector in the single New Session view**

In `new-session-view.tsx`, above `PromptInputV2Composer`, render a two-option selector with labels `language.t("session.new.kind.code")` and `language.t("session.new.kind.knowledge")` under group label `language.t("session.new.kind.label")`. When kind is `knowledge`, show hint `language.t("session.new.kind.knowledgeHint")` and `language.t("knowledge.folders.hint")` above the existing `NewSessionFolders` block. The selector calls `draft.setKind`; the composer, project selector, workspace selector, and folders UI stay shared. Do not create a second route or view component.

- [ ] **Step 3: Verify UI locally**

Run backend from `packages/flynncode` with `bun run ./src/index.ts serve --port 4096` and app from `packages/app` with `bun dev -- --port 4444`, then open `http://localhost:4444`. Confirm: new-session page shows Code/Knowledge switch, choosing Knowledge sets agent to knowledge in the model picker, extra folders still attach, and Home filter from Task 4 reflects the created session after first prompt. Do not restart shared dev servers owned by others; use local ports only.

- [ ] **Step 4: Typecheck**

Run: `bun typecheck` with `workdir` `packages/app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/new-session/new-session-view.tsx packages/app/src/pages/new-session/new-session-draft-controller.ts
git commit -m "feat(app): add session-new knowledge kind switch"
```

---

### Task 6: Knowledge grounding in system prompt plus empty state

**Files:**
- Modify: `packages/flynncode/src/session/system.ts` (read first; if system prompt assembly lives elsewhere, modify that file instead and note the path in the commit)
- Modify: `packages/app/src/pages/new-session/new-session-view.tsx` (empty-state hint area from Task 5)
- Test: `packages/flynncode/test/session/knowledge-system.test.ts`

**Interfaces:**
- Consumes: Task 3 `Knowledge.Service.list`, Task 2 `knowledge` agent name.
- Produces: knowledge file titles injected into system context only when `agent === "knowledge"`; empty-state copy guiding users to `.opencode/knowledge`.

- [ ] **Step 1: Write the failing test**

Create `packages/flynncode/test/session/knowledge-system.test.ts` asserting a pure helper `buildKnowledgePrologue(entries)` returns an empty string for zero entries and a bullet list of `title (slug)` lines otherwise. Keep the helper synchronous and pure so the test needs no filesystem.

```ts
import { describe, expect, test } from "bun:test"
import { buildKnowledgePrologue } from "@/session/system"

describe("buildKnowledgePrologue", () => {
  test("empty entries yield empty prologue", () => {
    expect(buildKnowledgePrologue([])).toBe("")
  })

  test("entries yield titled bullets", () => {
    const out = buildKnowledgePrologue([{ slug: "onboarding", title: "Onboarding" }])
    expect(out).toContain("Onboarding")
    expect(out).toContain("onboarding")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/knowledge-system.test.ts` with `workdir` `packages/flynncode`
Expected: FAIL with `buildKnowledgePrologue` not exported.

- [ ] **Step 3: Implement grounding**

Add exported synchronous `buildKnowledgePrologue(entries: Array<{ slug: string; title: string }>)` to the system-prompt module that returns `""` for empty input and otherwise returns a short prologue listing available knowledge notes plus the instruction to prefer them over guessing. Wire the caller so the prologue is appended to system context only when the active agent name is `knowledge`; code agents (`build`, `plan`) must see no change. Keep the list to titles and slugs (not full bodies) to bound context. In `new-session-view.tsx`, when kind is `knowledge` and the project has no knowledge files, show `language.t("knowledge.empty.title")` and `language.t("knowledge.empty.description")`.

- [ ] **Step 4: Run test and typecheck**

Run: `bun test test/session/knowledge-system.test.ts` with `workdir` `packages/flynncode`
Expected: PASS.

Run: `bun typecheck` with `workdir` `packages/flynncode`
Expected: PASS.

Run: `bun typecheck` with `workdir` `packages/app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flynncode/src/session/system.ts packages/flynncode/test/session/knowledge-system.test.ts packages/app/src/pages/new-session/new-session-view.tsx
git commit -m "feat(knowledge): ground knowledge sessions in project notes"
```

---

## Self-Review

- Spec coverage: Cowork local-mode traits (folder-scoped non-coding sessions, project knowledge grounding, one coherent home) map to Tasks 2-6; folder scope reuses extra-folders plumbing plus knowledge agent permissions; local-only execution preserved by reusing SessionRunner with no placement change; explicitly OUT items (vendor clouds, Sites hosting, voice, Computer History recording, Gmail/Slack/GitHub webhook triggers) have no task.
- Placeholder scan: no TBD/TODO/later; every step names exact files, exact key strings, exact permission maps, exact commands.
- Type consistency: `knowledge` agent name string is identical across backend registration, Home filter predicate, draft controller sync, and system grounding gate; `SessionKindFilter` and draft `kind` literals match (`all`/`code`/`knowledge` vs `code`/`knowledge`); Knowledge service signatures match between Interfaces and Task 3 test.
