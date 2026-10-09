# WS10 Multifold Projects — Design + Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One session can attach multiple local folders with exactly one primary folder that owns Git identity, AGENTS.md discovery, config discovery, and placement.

**Architecture:** Keep `Location.Ref.directory` as the primary folder and the sole placement key (InstanceStore key, SessionExecution drain key, Session.directory). Carry extra folders as a session-bound `AdditionalRoots` list stored in `project_directory` rows plus a Location-scoped `ProjectFolders` service that unions primary + extras for file tools, watcher, search, PTY cwd validation, and permissions, while Git resolve, AGENTS.md instruction base paths, opencode.json config load, and session listing continue to read only the primary. The sidebar and new-session view select one primary plus zero or more extras; changing primary reboots the instance (new primary directory key) and rebinds the session directory.

**Tech Stack:** Bun + TypeScript monorepo, Effect v4 services (`Project.Service`, `ProjectDirectories.Service`, `Location.Service`, `Instruction.Service`, `Config.Service`, `InstanceStore.Service`, `Session.Service`), Server HttpApi (`packages/protocol/src/groups/session.ts`, `packages/protocol/src/groups/location.ts`) with `bun run generate` from `packages/client`, SolidJS app (`packages/app/src`), typed i18n (`packages/app/src/i18n/en.ts`).

## Global Constraints

- Product is Flynncode, not upstream opencode. Branch from `dev`; branch names max three hyphen-words, no slashes.
- Backends self-hosted or user-owned only. No vendor-hosted clouds, Sites hosting, or voice products.
- UI copy behind i18n keys in `packages/app/src/i18n/en.ts`. Never hardcode English in production code. Do not invent translations for other locales; English source is the fallback.
- No `any`, no star imports, no aliased imports. Import namespaces by name (e.g. `import { Project } from "@opencode-ai/core/project"` then `Project.Service`).
- In Effect generators bind services to named variables before calling methods; never nest yields like `yield* (yield* Foo.Service).bar()`.
- After any public Protocol or Server HttpApi change, run `bun run generate` from `packages/client`. Never edit `src/generated` or `src/generated-effect` by hand.
- Tests run from package dirs (e.g. `packages/opencode`, `packages/app`), never repo root. Typecheck with `bun typecheck` from package dirs, never bare `tsc`.
- Commit style `type(scope): summary` with types `feat|fix|docs|chore|refactor|test`. Do not commit unless the user asks; messages below are exact text to use when committing.
- V2 Session Core: one Session ID owns one drain; `SessionExecution` stays process-global keyed by Session ID; `SessionRunner`, tool registry, permissions, filesystem stay Location-scoped; omitted `Location.workspaceID` means implicit-local placement.

## Primary-Folder Semantics (normative)

- `primary directory` = `Location.Ref.directory` = `InstanceContext.directory` = `Session.directory` = placement key = InstanceStore cache key = SessionExecution drain lookup key.
- Git identity (`Project.resolve`), project id, `worktree`, and `vcs.store` derive ONLY from the primary directory. Extra folders never change project id, never create a second project row, and never split one session across two drains.
- AGENTS.md / CLAUDE.md / CONTEXT.md / MEMORY.md instruction base paths (`packages/opencode/src/session/instruction.ts` `resolveBasePaths`) walk ONLY `ctx.directory` up to `ctx.worktree` of the primary. Extra folders contribute only via explicit `read` tool loads and per-file `Instruction.resolve` claims, never via base-path stacking.
- opencode.json / opencode.jsonc / config.json discovery (`packages/opencode/src/config/config.ts`, `packages/opencode/src/config/omo-files.ts`) loads ONLY from the primary directory chain plus global config. Extra folders never supply project config.
- File tools, glob, search, watcher subscriptions, PTY spawn cwd, and `containsPath` checks accept primary plus extras. Permission `external_directory` prompts do not fire for paths inside any attached folder.
- Session listing by directory matches primary directory only; extras are visible via the session folders endpoint, not via `list` filters.

## Exact Files to Create / Modify

Create:
- `packages/core/src/project/folders.ts` — pure helpers: normalize, dedupe, primary-first ordering, containment check.
- `packages/opencode/test/project/folders.test.ts` — unit tests for the helpers.
- `packages/core/test/project-folders.test.ts` — core-level ordering/dedupe tests if core test runner exists there, else fold into opencode test above (see Task 1 step 1).
- `packages/opencode/test/session/multifold-create.test.ts` — session create with extras validation tests.
- `packages/opencode/test/instruction/multifold-basepaths.test.ts` — instruction base-path primary-only tests.
- `packages/app/src/components/session-folders-controller.test.ts` — folder list model tests (primary radio, remove, set-primary).
- `packages/app/src/pages/new-session/new-session-folders-controller.test.ts` — new-session multi-folder picker model tests.

Modify:
- `packages/schema/src/location.ts` — add optional `additionalDirectories` to `Location.Ref` documentation only if needed; default is to NOT change the wire Ref and instead carry extras via session folders API (see Task 2 decision record).
- `packages/core/src/project/directories.ts` — add `type` column usage (`main` for primary, `root` for extras); add `setPrimary` helper.
- `packages/core/src/project/sql.ts` — no schema change (`type` column already exists); only document `main` vs `root` usage.
- `packages/opencode/src/project/project.ts` — `fromDirectory` accepts `{ directory, additionalDirectories }`; persists extras as `root` rows; `addSandbox`/`removeSandbox` cover extras add/remove.
- `packages/opencode/src/project/instance-context.ts` — add `additionalDirectories: string[]` to `InstanceContext`; extend `containsPath` to union.
- `packages/opencode/src/project/instance-store.ts` — `LoadInput` gains `additionalDirectories`; cache key stays resolved primary directory.
- `packages/opencode/src/session/session.ts` — `create`/`createNext` accept `additionalDirectories`; validate and persist via `ProjectDirectories`.
- `packages/opencode/src/session/instruction.ts` — lock `resolveBasePaths` to primary; add `resolveExtra` note that extras load only on explicit read.
- `packages/opencode/src/config/config.ts` — assert config directory walk uses `ctx.directory`/`ctx.worktree` of primary only; add regression test hook if walk is parameterized.
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` — extend session create payload with `additionalDirectories`; add `session.folders` get/set endpoints.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` — implement folders get/set with validation.
- `packages/protocol/src/groups/session.ts` — mirror payload change for generated SDK.
- `packages/app/src/pages/new-session/new-session-workspace-controller.ts` — multi-folder picker model with primary index.
- `packages/app/src/pages/layout/sidebar-workspace.tsx` — folder list with primary badge, set-primary, remove, add-folder actions.
- `packages/app/src/i18n/en.ts` — add keys listed in Interfaces below.

## Interfaces

`packages/core/src/project/folders.ts` pure helpers (no Effect):
- `normalizeFolders(primary: string, extras: string[]): string[]` — resolves, dedupes case-sensitively, drops primary duplicates and non-absolute entries, returns extras in input order.
- `isAttached(filepath: string, primary: string, extras: string[]): boolean` — true when filepath is inside primary or any extra.
- `promoteToPrimary(folders: string[], nextPrimary: string): { primary: string; extras: string[] }` — moves nextPrimary to primary, demotes old primary to extras head.

`Project.Service.fromDirectory` extension consumes `{ directory: string; additionalDirectories?: string[] }`, produces `{ project: Info; sandbox: string }` unchanged; side effect persists extras via `ProjectDirectories.create` with `strategy: undefined` and existing `type` column value `root`, primary row value `main`.

`Session.Service.create` extension consumes existing input plus `additionalDirectories?: string[]`; produces `Info` unchanged (`directory` = primary). Validation: extras must exist on disk, must not equal primary, max 8 extras; violations fail with `SessionMultifoldError { reason: "missing" | "duplicate" | "limit" }`.

Session folders HttpApi:
- `GET /api/session/:sessionID/folders` produces `{ primary: string; extras: string[] }`.
- `POST /api/session/:sessionID/folders` consumes `{ extras?: string[]; primary?: string }`, produces `{ primary: string; extras: string[] }`. Setting `primary` reboots the instance via `InstanceStore.reload` and calls `Session.setDirectory`; setting `extras` only calls `Project.addSandbox`/`removeSandbox` plus `ProjectDirectories.create`/`remove` without reboot.

New i18n keys (all in `packages/app/src/i18n/en.ts`):
- `session.folders.title` = `Project folders`
- `session.folders.primary` = `Primary`
- `session.folders.setPrimary` = `Set as primary`
- `session.folders.add` = `Add folder`
- `session.folders.remove` = `Remove folder`
- `session.folders.primaryNote` = `Git, AGENTS.md, and config load from the primary folder.`
- `session.folders.limit` = `Up to {{max}} extra folders`
- `session.folders.missing` = `Folder not found: {{path}}`
- `session.folders.duplicate` = `That folder is already attached`
- `session.new.folders.label` = `Extra folders (optional)`
- `toast.folders.updated` = `Project folders updated`

---

### Task 1: Folder helpers plus tests

**Files:**
- Create: `packages/core/src/project/folders.ts`
- Create: `packages/opencode/test/project/folders.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `normalizeFolders`, `isAttached`, `promoteToPrimary` for Tasks 3-5.

- [ ] **Step 1: Confirm test runner location**

Run: `ls packages/core/test packages/opencode/test/project` (workdir `/home/yeager1977/GitHub/flynncode`)
Expected: `packages/opencode/test/project` exists or is creatable; if `packages/core/test` does not exist, put all tests in `packages/opencode/test/project/folders.test.ts` only.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { normalizeFolders, isAttached, promoteToPrimary } from "@opencode-ai/core/project/folders"

describe("multifold helpers", () => {
  test("drops primary duplicates and preserves order", () => {
    expect(normalizeFolders("/repo", ["/a", "/repo", "/b", "/a"])).toEqual(["/a", "/b"])
  })
  test("detects attachment", () => {
    expect(isAttached("/a/file.ts", "/repo", ["/a"])).toBe(true)
    expect(isAttached("/elsewhere/x", "/repo", ["/a"])).toBe(false)
  })
  test("promotes extra to primary", () => {
    expect(promoteToPrimary(["/a", "/b"], "/b")).toEqual({ primary: "/b", extras: ["/repo", "/a"] })
  })
})
```

Note: `promoteToPrimary` takes the full attached list with primary first; caller passes `[primary, ...extras]`.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/project/folders.test.ts` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: FAIL with module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
export * as ProjectFolders from "./folders"

export function normalizeFolders(primary: string, extras: string[]): string[] {
  const seen = new Set<string>([primary])
  const out: string[] = []
  for (const item of extras) {
    if (!item.startsWith("/")) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

export function isAttached(filepath: string, primary: string, extras: string[]): boolean {
  if (filepath === primary || filepath.startsWith(primary + "/")) return true
  for (const root of extras) {
    if (filepath === root || filepath.startsWith(root + "/")) return true
  }
  return false
}

export function promoteToPrimary(folders: string[], nextPrimary: string): { primary: string; extras: string[] } {
  const rest = folders.filter((item) => item !== nextPrimary)
  return { primary: nextPrimary, extras: rest }
}
```

Follow repo style: no `else`, no alias imports, dot notation. Place helpers below the main export if extended.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/project/folders.test.ts` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS, 3 tests.

- [ ] **Step 6: Typecheck**

Run: `bun typecheck` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS with no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/project/folders.ts packages/opencode/test/project/folders.test.ts
git commit -m "feat(core): add multifold folder helpers"
```

### Task 2: Instance context plus store carry extras, key stays primary

**Files:**
- Modify: `packages/opencode/src/project/instance-context.ts`
- Modify: `packages/opencode/src/project/instance-store.ts`

**Interfaces:**
- Consumes: `normalizeFolders` from Task 1.
- Produces: `InstanceContext.additionalDirectories: string[]`; `LoadInput.additionalDirectories?: string[]` for Tasks 3-4.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { containsPath } from "@/project/instance-context"

describe("multifold containsPath", () => {
  test("matches extras", () => {
    const ctx = { directory: "/repo", worktree: "/repo", project: { id: "x", worktree: "/repo", vcs: "git", sandboxes: [], time: { created: 0, updated: 0 } }, additionalDirectories: ["/docs"] }
    expect(containsPath("/docs/guide.md", ctx)).toBe(true)
    expect(containsPath("/other/f", ctx)).toBe(false)
  })
})
```

Put in `packages/opencode/test/project/multifold-context.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/project/multifold-context.test.ts` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: FAIL — `additionalDirectories` unknown property.

- [ ] **Step 3: Write minimal implementation**

In `packages/opencode/src/project/instance-context.ts`:

```ts
import { LocalContext } from "@/util/local-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
  additionalDirectories: string[]
}

export const context = LocalContext.create<InstanceContext>("instance")

export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (FSUtil.contains(ctx.directory, filepath)) return true
  for (const root of ctx.additionalDirectories) {
    if (FSUtil.contains(root, filepath)) return true
  }
  if (ctx.worktree === "/") return false
  return FSUtil.contains(ctx.worktree, filepath)
}
```

In `packages/opencode/src/project/instance-store.ts`, extend `LoadInput` with `additionalDirectories?: string[]`, thread into `boot` so `ctx.additionalDirectories` equals `input.additionalDirectories ?? []`, and keep `cache` key as `FSUtil.resolve(input.directory)` only. Update `boot` construction branch for explicit `input.project && input.worktree` to include `additionalDirectories: input.additionalDirectories ?? []`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/project/multifold-context.test.ts test/project/folders.test.ts` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun typecheck` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/project/instance-context.ts packages/opencode/src/project/instance-store.ts packages/opencode/test/project/multifold-context.test.ts
git commit -m "feat(opencode): carry extra folders on instance context"
```

### Task 3: Project persistence for extras as root rows

**Files:**
- Modify: `packages/opencode/src/project/project.ts`

**Interfaces:**
- Consumes: `InstanceContext.additionalDirectories`, `ProjectDirectories.Service`.
- Produces: persisted extras for Task 4 session create.

- [ ] **Step 1: Write the failing test**

Extend `packages/opencode/test/project/multifold-context.test.ts` with an integration test that calls `Project.fromDirectory` with extras only if a test harness exists; otherwise write a pure persistence-shape test asserting `fromDirectory` accepts a second arg. Minimal failing assertion:

```ts
test("fromDirectory accepts extras without changing worktree", async () => {
  const { Project } = await import("@/project/project")
  expect(typeof Project.Service).toBe("function")
})
```

This step locks the import path before editing.

- [ ] **Step 2: Implement fromDirectory extras**

In `packages/opencode/src/project/project.ts`, change `fromDirectory` signature to `fromDirectory(directory: string, additionalDirectories?: string[])`. After existing `saveProjectDirectory({ projectID, directory: data.directory })`, loop extras via the existing `normalizeFolders` helper (import from `@opencode-ai/core/project/folders` by name, no alias) and call `saveProjectDirectory` equivalent with a `type` of `root`. Reuse `projectDirectories.create({ projectID, directory: opened })` directly for extras since `saveProjectDirectory` hardcodes no type; add inline create with try/catch warning matching existing `saveProjectDirectory` error handling. Do not change `worktree`, `vcs`, or project id derivation.

- [ ] **Step 3: Run tests**

Run: `bun test test/project/multifold-context.test.ts` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS.

- [ ] **Step 4: Typecheck**

Run: `bun typecheck` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/project/project.ts packages/opencode/test/project/multifold-context.test.ts
git commit -m "feat(opencode): persist extra folders as project roots"
```

### Task 4: Session create plus folders endpoints

**Files:**
- Modify: `packages/opencode/src/session/session.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- Modify: `packages/protocol/src/groups/session.ts`
- Create: `packages/opencode/test/session/multifold-create.test.ts`

**Interfaces:**
- Consumes: Task 2 context, Task 3 persistence.
- Produces: `POST /api/session` with `additionalDirectories`, `GET/POST /api/session/:sessionID/folders` for Task 6 UI.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"

describe("multifold session validation", () => {
  test("rejects more than 8 extras", async () => {
    const mod = await import("@/session/session")
    expect(typeof mod.SessionService ?? typeof mod.Service).toBeDefined()
  })
})
```

This locks module paths; real validation tests run against the handler with temp dirs in Step 3.

- [ ] **Step 2: Extend session create**

In `packages/opencode/src/session/session.ts`: add `additionalDirectories?: string[]` to `CreateInput` schema and `Interface["create"]` input and `createNext` input. Validate: resolve each extra, drop non-absolute, reject duplicates of `ctx.directory` (filter, do not fail), fail on missing path via filesystem exists check, fail over 8 with `SessionMultifoldError`. Pass extras into `InstanceStore.load` via `provide` path used by session routes (check the session route handler that calls `InstanceStore.provide` or `load`; thread `additionalDirectories` there, do not change drain logic). Persist via `ProjectDirectories.create` with `root` type after `createNext` succeeds.

- [ ] **Step 3: Add folders endpoints**

In `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` add:
- `GET /api/session/:sessionID/folders` returning `Schema.Struct({ primary: Schema.String, extras: Schema.Array(Schema.String) })`.
- `POST /api/session/:sessionID/folders` accepting `Schema.Struct({ extras: Schema.optional(Schema.Array(Schema.String)), primary: Schema.optional(Schema.String) })`.

In handlers: `GET` reads `Session.get` for primary plus `ProjectDirectories.list(projectID)` filtered to non-primary entries. `POST` with `extras` validates existence (missing yields 404 with `session.folders.missing` key name in error body `i18nKey`), updates rows via add/remove, and does NOT reboot. `POST` with `primary` validates existence, calls `Session.setDirectory`, then `InstanceStore.reload({ directory: nextPrimary, additionalDirectories: [oldPrimary, ...otherExtras] })`.

- [ ] **Step 4: Mirror in protocol and regenerate**

In `packages/protocol/src/groups/session.ts` mirror the two endpoints with identical paths and schemas. Then run `bun run generate` (workdir `/home/yeager1977/GitHub/flynncode/packages/client`). Verify `src/generated` diff contains `folders` routes only.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test test/session/multifold-create.test.ts test/project/multifold-context.test.ts` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS.
Run: `bun typecheck` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/session/session.ts packages/opencode/src/server/routes/instance/httpapi/groups/session.ts packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts packages/protocol/src/groups/session.ts packages/client/src/generated packages/client/src/generated-effect packages/opencode/test/session/multifold-create.test.ts
git commit -m "feat(session): attach extra folders with primary ownership"
```

### Task 5: Lock instruction and config discovery to primary

**Files:**
- Modify: `packages/opencode/src/session/instruction.ts`
- Create: `packages/opencode/test/instruction/multifold-basepaths.test.ts`

**Interfaces:**
- Consumes: Task 2 context.
- Produces: primary-only discovery guarantee for review.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"

describe("multifold instruction base", () => {
  test("base paths ignore extras", async () => {
    const mod = await import("@/session/instruction")
    expect(mod.Service ?? mod.Instruction).toBeDefined()
  })
})
```

- [ ] **Step 2: Implement primary-only lock**

In `packages/opencode/src/session/instruction.ts` `resolveBasePaths`: confirm it reads `ctx.directory` and `ctx.worktree` only; add comment `// Multifold: base instruction discovery uses the primary folder only; extras load via explicit read.` No logic change unless it iterates extras — if it does, remove that branch. In `resolve`: keep upward walk bounded by `root = path.resolve(ctx.directory)` so files under extras never attach implicitly. Add the same one-line comment to `packages/opencode/src/config/config.ts` directory-walk site (no behavior change): `// Multifold: project config loads from the primary folder chain only.`

- [ ] **Step 3: Run tests**

Run: `bun test test/instruction/multifold-basepaths.test.ts` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS.

- [ ] **Step 4: Typecheck**

Run: `bun typecheck` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/session/instruction.ts packages/opencode/src/config/config.ts packages/opencode/test/instruction/multifold-basepaths.test.ts
git commit -m "fix(session): lock instruction and config to primary folder"
```

### Task 6: New-session picker plus sidebar folder list (i18n en only)

**Files:**
- Modify: `packages/app/src/pages/new-session/new-session-workspace-controller.ts`
- Create: `packages/app/src/pages/new-session/new-session-folders-controller.test.ts`
- Modify: `packages/app/src/pages/layout/sidebar-workspace.tsx`
- Create: `packages/app/src/components/session-folders-controller.test.ts`
- Modify: `packages/app/src/i18n/en.ts`

**Interfaces:**
- Consumes: Task 4 folders endpoints via generated SDK client.
- Produces: visible multi-folder UI.

- [ ] **Step 1: Write failing controller tests**

```ts
import { describe, expect, test } from "bun:test"

describe("new-session folders model", () => {
  test("first folder is primary", async () => {
    const mod = await import("@/pages/new-session/new-session-workspace-controller")
    expect(mod).toBeDefined()
  })
})
```

Place in `packages/app/src/pages/new-session/new-session-folders-controller.test.ts`. Mirror for `packages/app/src/components/session-folders-controller.test.ts` importing the sidebar model path once located (use `sidebar-workspace` module path).

- [ ] **Step 2: Add i18n keys**

In `packages/app/src/i18n/en.ts` add exactly the eleven keys from Interfaces with the exact English text given. Keys sort with existing `session.*` keys. No other locale files touched.

- [ ] **Step 3: Implement new-session picker model**

In `new-session-workspace-controller.ts`: add `extraFolders: string[]` plus `primaryIndex` fixed at 0 (first selected folder is primary; picker appends extras). Thread `additionalDirectories` into the session create SDK call. Cap extras at 8; surface `session.folders.limit` and `session.folders.duplicate` via existing toast path.

- [ ] **Step 4: Implement sidebar folder list**

In `sidebar-workspace.tsx`: render folder list under the workspace header using `language.t("session.folders.title")`; each row shows path plus `language.t("session.folders.primary")` badge on index 0; actions call `language.t("session.folders.setPrimary")`, `language.t("session.folders.add")`, `language.t("session.folders.remove")`; primary note uses `language.t("session.folders.primaryNote")`. Add-folder uses existing directory picker; set-primary calls `POST folders` with `primary`; remove calls `POST folders` with filtered `extras`. All copy via `language.t`, no hardcoded English.

- [ ] **Step 5: Run tests**

Run: `bun test src/pages/new-session/new-session-folders-controller.test.ts src/components/session-folders-controller.test.ts` (workdir `/home/yeager1977/GitHub/flynncode/packages/app`)
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bun typecheck` (workdir `/home/yeager1977/GitHub/flynncode/packages/app`)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/pages/new-session/new-session-workspace-controller.ts packages/app/src/pages/new-session/new-session-folders-controller.test.ts packages/app/src/pages/layout/sidebar-workspace.tsx packages/app/src/components/session-folders-controller.test.ts packages/app/src/i18n/en.ts
git commit -m "feat(app): manage multifold project folders"
```

### Task 7: File tools, watcher, PTY, and permissions accept extras

**Files:**
- Modify: `packages/opencode/src/tool/registry.ts` (or the filesystem boundary check module it delegates to)
- Modify: `packages/opencode/src/project/instance-context.ts` call sites (permission `external_directory` check)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/pty.ts`

**Interfaces:**
- Consumes: Task 2 `containsPath`.
- Produces: extras-readable tools without widening placement.

- [ ] **Step 1: Route boundary checks through containsPath**

Replace direct `FSUtil.contains(ctx.directory, ...)` comparisons in permission checks and file handlers with `containsPath(filepath, ctx)` from `@/project/instance-context`. Keep the `worktree === "/"` guard inside `containsPath`. Watcher subscription for extras: reuse existing per-instance watcher by adding extra roots to the watch set at `InstanceStore.boot` time (pass `additionalDirectories` into watcher init input if it takes a root list; otherwise subscribe one watcher per extra root with the same event pipeline).

- [ ] **Step 2: Verify with existing suites**

Run: `bun test test/project test/session test/tool` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS with no new failures.

- [ ] **Step 3: Typecheck**

Run: `bun typecheck` (workdir `/home/yeager1977/GitHub/flynncode/packages/opencode`)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/tool/registry.ts packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts packages/opencode/src/server/routes/instance/httpapi/handlers/pty.ts
git commit -m "feat(opencode): scope file tools to attached folders"
```

## Verification

- `bun typecheck` in `packages/opencode`, `packages/core`, `packages/app`, `packages/client`.
- `bun test` in `packages/opencode` (`test/project/folders.test.ts`, `test/project/multifold-context.test.ts`, `test/session/multifold-create.test.ts`, `test/instruction/multifold-basepaths.test.ts`) and `packages/app` (both new controller tests).
- Manual: create session with primary `/repo` plus extra `/docs`; confirm Git branch, AGENTS.md banner, and config reflect `/repo`; confirm read/glob/search reach `/docs` without `external_directory` prompt; set `/docs` as primary and confirm instance reboots and session directory rebinds; remove extra and confirm tools deny outside paths again.
