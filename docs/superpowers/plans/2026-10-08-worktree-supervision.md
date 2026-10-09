# WS1 Worktree Supervision — Design + Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every chat session can own a disposable git worktree with enforced retention and one-click checkout handoff, and every subagent can run isolated in a temp worktree with per-agent model and permission overrides.

**Architecture:** The `Worktree` Effect service in `packages/opencode/src/worktree/index.ts` already implements create-and-retain (default keep 15), list, remove, reset, and dirty-state-carrying handoff behind the experimental HttpApi; this workstream wires those primitives into session lifecycle (per-chat ownership plus dispose-on-archive) and into the task tool (temp-worktree child sessions), then surfaces retention, handoff, and isolation controls in the new-session view and sidebar workspace menu behind i18n keys. Session-to-worktree binding stays a plain directory association plus project sandbox row; no new durable session table is introduced. Per-agent isolation and model override resolve from existing agent config (`model`, `permission`, `mode` in `packages/core/src/v1/config/agent.ts`) extended with two optional fields, consumed only by the task tool at spawn time.

**Tech Stack:** Bun + TypeScript monorepo, Effect v4 services (`Worktree.Service`, `Session.Service`, `Agent.Service`, `TaskTool`), Server HttpApi experimental worktree group with generated JS SDK, SolidJS app (`packages/app/src/pages/new-session`, `packages/app/src/pages/layout`), typed i18n (`packages/app/src/i18n/en.ts` plus `worktree-fallback.ts`).

## Global Constraints

- Product is Flynncode, not upstream opencode. Branch from `dev`; branch names max three hyphen-words, no slashes.
- Backends self-hosted or user-owned only. No vendor-hosted clouds, Sites hosting, or voice products.
- UI copy behind i18n keys in `packages/app/src/i18n/en.ts`. Never hardcode English in production code. Do not invent translations for other locales; English source is the fallback.
- No `any`, no star imports, no aliased imports. Import namespaces by name (e.g. `import { Worktree } from "@/worktree/index"` then `Worktree.Service`).
- In Effect generators bind services to named variables before calling methods; never nest yields like `yield* (yield* Foo.Service).bar()`.
- After any public Protocol or Server HttpApi change, run `bun run generate` from `packages/client`. Never edit `src/generated` or `src/generated-effect` by hand.
- Tests run from package dirs (e.g. `packages/opencode`, `packages/app`), never repo root. Typecheck with `bun typecheck` from package dirs, never bare `tsc`.
- Commit style `type(scope): summary` with types `feat|fix|docs|chore|refactor|test`. Do not commit unless the user asks; messages below are exact text to use when committing.

## Exact Files to Create / Modify

Create:
- `packages/opencode/src/worktree/session-binding.ts` — pure helpers mapping session directory to worktree ownership (owner session id, disposable flag, dispose policy).
- `packages/opencode/test/worktree/session-binding.test.ts` — unit tests for the helpers.
- `packages/opencode/test/worktree/subagent-isolation.test.ts` — unit tests for temp-worktree name/dir resolution and cleanup decision.
- `packages/opencode/test/tool/task-isolation.test.ts` — task-tool isolation option parsing and child permission merge.
- `packages/app/src/pages/new-session/new-session-worktree-controller.test.ts` — controller tests for disposable-worktree selection.
- `packages/app/src/pages/layout/sidebar-worktree-menu.test.ts` — menu model tests for remove/reset/handoff actions.

Modify:
- `packages/opencode/src/tool/task.ts` — add `isolation` and `cleanup` params; spawn child session in temp worktree via `Worktree.Service`.
- `packages/opencode/src/agent/subagent-permissions.ts` — accept per-agent permission override for isolated children.
- `packages/core/src/v1/config/agent.ts` — add optional `isolation` and `sandbox` fields to agent info.
- `packages/opencode/src/worktree/index.ts` — add `createDisposable` (temp worktree bound to session id) and `disposeIfIdle` (remove only when no loaded instance); keep existing `createAndRetain`, `remove`, `reset`, `handoff` signatures.
- `packages/opencode/src/worktree/retention.ts` — extend entry with `disposable` and `lastUsedAt`; keep `worktreesToRemove(entries, limit)` signature.
- `packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts` — add `worktreeDispose` endpoint only if a new route is needed; otherwise reuse `worktreeRemove`.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts` — handle dispose/handoff session rebinding.
- `packages/opencode/src/session/session.ts` — accept `directory` override on create (already present) plus record disposable binding via `session-binding` helper; rebind directory on handoff.
- `packages/app/src/pages/new-session/new-session-workspace-controller.ts` — add disposable-worktree option (`main | create | disposable | <existing>`).
- `packages/app/src/pages/new-session/new-session-draft-controller.ts` — thread disposable flag into session creation.
- `packages/app/src/pages/layout/sidebar-workspace.tsx` — add per-worktree remove/reset/handoff menu items and retention count display.
- `packages/app/src/i18n/en.ts` — add keys listed in Interfaces below.
- `packages/app/src/i18n/worktree-fallback.ts` — no logic change; fallback picks up new `session.worktree.*` keys only if the key filter is extended (see Task 7).

## Interfaces

`packages/opencode/src/worktree/session-binding.ts` consumes `{ sessionID: string; directory: string; disposable: boolean }` and produces `{ ownerKey: string; disposeOnArchive: boolean; displayName: string }`. Pure functions:
- `bindingKey(sessionID: string, directory: string): string`
- `shouldDispose(binding: Binding, opts: { archived: boolean; running: boolean }): boolean`
- `displayName(directory: string, projectRoot: string): string`

`Worktree.createDisposable(input: { sessionID: string; name?: string })` consumes a session id, produces `Worktree.Info` via existing `makeWorktreeInfo` + `createFromInfo` with branch prefix `opencode/session-<slug>`. `Worktree.disposeIfIdle(input: { directory: string })` consumes a directory, checks `InstanceStore.loadedDirectories()`, produces `boolean` (true when removed, false when still running).

`TaskTool` new params consume:
- `isolation: Schema.optional(Schema.Literals(["inherit", "worktree"]))` — default `"inherit"`.
- `cleanup: Schema.optional(Schema.Literals(["retain", "dispose"]))` — default `"retain"`.
Produces a child session whose `directory` is the temp worktree directory when `isolation === "worktree"`, plus metadata `{ worktree: directory; disposable: cleanup === "dispose" }`.

Agent config extension consumes existing `ConfigAgentV1.Info` and produces the same shape plus:
- `isolation: Schema.optional(Schema.Literals(["inherit", "worktree"]))`
- `sandbox: Schema.optional(Schema.String)` (free-form sandbox profile name resolved by permission layer; unknown values degrade to default instead of failing config load, matching `ConfigWorktree.settings` tolerance).

New i18n keys (all in `packages/app/src/i18n/en.ts`):
- `session.worktree.disposable` = `Disposable worktree (dispose on archive)`
- `session.worktree.disposableDescription` = `Create a temp worktree for this chat. It is removed when the session is archived.`
- `session.worktree.retainedCount` = `{{count}} worktrees (keeps {{keep}})`
- `session.worktree.remove` = `Remove worktree`
- `session.worktree.reset` = `Reset to default branch`
- `session.worktree.handoff` = `Hand off session here`
- `session.worktree.handoffOccupied` = `That worktree already has an active session`
- `session.worktree.dispose` = `Dispose disposable worktree`
- `session.subagents.isolatedIn` = `Isolated in {{directory}}`
- `session.subagents.isolationWorktree` = `Run in temp worktree`
- `toast.worktree.disposed.description` = `Disposable worktree removed`

---

### Task 1: Session-binding pure helpers plus tests

**Files:**
- Create: `packages/opencode/src/worktree/session-binding.ts`
- Test: `packages/opencode/test/worktree/session-binding.test.ts`

**Interfaces:**
- Consumes: `{ sessionID, directory, disposable }`
- Produces: `bindingKey`, `shouldDispose`, `displayName`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { bindingKey, displayName, shouldDispose } from "../../src/worktree/session-binding"

describe("session-binding", () => {
  test("keys binding by session and directory", () => {
    expect(bindingKey("ses_1", "/repo/.opencode/worktrees/a")).toBe("ses_1::/repo/.opencode/worktrees/a")
  })

  test("disposes only archived non-running disposable bindings", () => {
    const binding = { sessionID: "ses_1", directory: "/w/a", disposable: true }
    expect(shouldDispose(binding, { archived: true, running: false })).toBe(true)
    expect(shouldDispose(binding, { archived: true, running: true })).toBe(false)
    expect(shouldDispose(binding, { archived: false, running: false })).toBe(false)
    expect(shouldDispose({ ...binding, disposable: false }, { archived: true, running: false })).toBe(false)
  })

  test("displays leaf name against project root", () => {
    expect(displayName("/repo/.opencode/worktrees/a", "/repo")).toBe("a")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/opencode`: `bun test test/worktree/session-binding.test.ts`
Expected: FAIL with `Cannot find module "../../src/worktree/session-binding"`.

- [ ] **Step 3: Implement `session-binding.ts`**

Write pure functions only: `bindingKey` joins with `::`; `shouldDispose` returns `binding.disposable && opts.archived && !opts.running`; `displayName` returns the last path segment via `path.basename`, falling back to the full directory when basename is empty. No Effect, no imports beyond `node:path` via `import path from "node:path"`.

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/opencode`: `bun test test/worktree/session-binding.test.ts`
Expected: PASS, 3 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run from `packages/opencode`: `bun typecheck`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

Exact commit message: `feat(worktree): add session-binding helpers`

### Task 2: Retention entries carry disposable plus last-used

**Files:**
- Modify: `packages/opencode/src/worktree/retention.ts`
- Test: `packages/opencode/test/worktree/retention.test.ts` (check for existing file first with `glob test/worktree/*`; create it if absent)

**Interfaces:**
- Consumes: `WorktreeRetentionEntry` with new optional `disposable?: boolean` and `lastUsedAt?: number`
- Produces: unchanged `worktreesToRemove(entries, limit): string[]`; disposable entries sort as most-recently-used via `lastUsedAt ?? updated`

- [ ] **Step 1: Write the failing test**

Append to the retention test file:

```ts
import { describe, expect, test } from "bun:test"
import { worktreesToRemove } from "../../src/worktree/retention"

describe("worktreesToRemove disposable", () => {
  test("never removes open or running entries and prefers idle disposables past the limit", () => {
    const entries = [
      { directory: "/w/keep-open", updated: 1, open: true },
      { directory: "/w/keep-running", updated: 2, running: true },
      { directory: "/w/old", updated: 3 },
      { directory: "/w/new", updated: 4 },
      { directory: "/w/disposable", updated: 5, disposable: true, lastUsedAt: 0 },
    ]
    expect(worktreesToRemove(entries, 2)).toEqual(["/w/disposable", "/w/old"])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/opencode`: `bun test test/worktree/retention.test.ts`
Expected: FAIL on the new case (disposable entry not ordered for removal first) or file-missing error if creating new.

- [ ] **Step 3: Implement**

Extend `WorktreeRetentionEntry` with `disposable?: boolean` and `lastUsedAt?: number`. In `worktreesToRemove`, sort by `(lastUsedAt ?? updated)` descending; keep the existing keep-set logic (`open || running || kept.size < limit` keeps, else removes). Do not change the exported function name or arity.

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/opencode`: `bun test test/worktree/retention.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Typecheck**

Run from `packages/opencode`: `bun typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

Exact commit message: `feat(worktree): order retention by last use with disposable flag`

### Task 3: `createDisposable` plus `disposeIfIdle` on the Worktree service

**Files:**
- Modify: `packages/opencode/src/worktree/index.ts`
- Test: `packages/opencode/test/worktree/subagent-isolation.test.ts` (create; covers name/dir resolution plus cleanup decision against `session-binding.shouldDispose`)

**Interfaces:**
- Consumes: `{ sessionID: string; name?: string }`
- Produces: `Worktree.Info` via `makeWorktreeInfo` + `createFromInfo`; `disposeIfIdle({ directory })` produces `boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { shouldDispose } from "../../src/worktree/session-binding"

describe("subagent isolation cleanup", () => {
  test("disposable temp worktree is removed only when archived and idle", () => {
    const binding = { sessionID: "ses_child", directory: "/repo/.opencode/worktrees/ses-child", disposable: true }
    expect(shouldDispose(binding, { archived: true, running: false })).toBe(true)
    expect(shouldDispose(binding, { archived: false, running: false })).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/opencode`: `bun test test/worktree/subagent-isolation.test.ts`
Expected: FAIL with missing `session-binding` module until Task 1 lands; if Task 1 landed, this test passes and the remaining failure is the missing `createDisposable`/`disposeIfIdle` exports asserted in Step 3 implementation check via `bun typecheck`.

- [ ] **Step 3: Implement**

In `packages/opencode/src/worktree/index.ts`: add `createDisposable` to the `Interface` and service return object. Implement it by calling the existing `makeWorktreeInfo({ name: session-${sessionID-slug} })` then `createFromInfo(info)`. Add `disposeIfIdle`: canonicalize the directory, read `store.loadedDirectories()`, return false when the canonical key is present (still running) or equals the current `ctx.worktree`; otherwise call existing `remove({ directory })` and return true. Reuse `canonical`, `remove`, `candidate` helpers; add no new git commands.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `packages/opencode`: `bun test test/worktree/session-binding.test.ts test/worktree/subagent-isolation.test.ts test/worktree/retention.test.ts`
Expected: PASS across all three files.

- [ ] **Step 5: Typecheck**

Run from `packages/opencode`: `bun typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

Exact commit message: `feat(worktree): add disposable create and idle dispose`

### Task 4: Agent config `isolation` plus `sandbox` fields

**Files:**
- Modify: `packages/core/src/v1/config/agent.ts`
- Test: `packages/core/test/agent-config.test.ts` (check with `glob` first; create if absent under `packages/core/test/`)

**Interfaces:**
- Consumes: existing `ConfigAgentV1.Info` input
- Produces: same shape plus optional `isolation` (`inherit | worktree`) and `sandbox` (string); unknown values degrade to `undefined`, never throw

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigAgentV1 } from "../src/v1/config/agent"

describe("agent isolation config", () => {
  test("accepts isolation and sandbox overrides", () => {
    const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ isolation: "worktree", sandbox: "restricted" })
    expect(decoded.isolation).toBe("worktree")
    expect(decoded.sandbox).toBe("restricted")
  })

  test("degrades unknown isolation to undefined", () => {
    const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ isolation: "cloud-vm" })
    expect(decoded.isolation).toBeUndefined()
  })
})
```

Adjust the exact export name (`ConfigAgentV1.Info` vs the file's actual struct) to match what `packages/core/src/v1/config/agent.ts` exports after reading the top 60 lines; keep the two test cases.

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/core`: `bun test test/agent-config.test.ts`
Expected: FAIL (`isolation` stripped or decode error).

- [ ] **Step 3: Implement**

Add `isolation: Schema.optional(Schema.Literals(["inherit", "worktree"]))` and `sandbox: Schema.optional(Schema.String)` to the agent info struct with descriptions. Wrap decode so unknown `isolation` strings fall back to `undefined` (use `Schema.optional` with a tolerant annotation consistent with `ConfigWorktree.settings` tolerance; do not throw on unknown).

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/core`: `bun test test/agent-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run from `packages/core`: `bun typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

Exact commit message: `feat(agent): add isolation and sandbox overrides`

### Task 5: Task tool spawns isolated children in temp worktrees

**Files:**
- Modify: `packages/opencode/src/tool/task.ts`
- Modify: `packages/opencode/src/agent/subagent-permissions.ts`
- Test: `packages/opencode/test/tool/task-isolation.test.ts`

**Interfaces:**
- Consumes: `isolation` (`inherit | worktree`, default `inherit`), `cleanup` (`retain | dispose`, default `retain`), agent `isolation`/`sandbox` defaults
- Produces: child session with `directory` set to temp worktree dir when isolated; metadata `{ worktree, disposable }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Parameters } from "../../src/tool/task"

describe("task isolation params", () => {
  test("defaults to inherit and retain", () => {
    const decoded = Schema.decodeUnknownSync(Parameters)({
      description: "scan repo",
      prompt: "find dead code",
      subagent_type: "explore",
    })
    expect(decoded.isolation ?? "inherit").toBe("inherit")
    expect(decoded.cleanup ?? "retain").toBe("retain")
  })

  test("accepts worktree isolation with dispose cleanup", () => {
    const decoded = Schema.decodeUnknownSync(Parameters)({
      description: "scan repo",
      prompt: "find dead code",
      subagent_type: "explore",
      isolation: "worktree",
      cleanup: "dispose",
    })
    expect(decoded.isolation).toBe("worktree")
    expect(decoded.cleanup).toBe("dispose")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/opencode`: `bun test test/tool/task-isolation.test.ts`
Expected: FAIL (`isolation`/`cleanup` unknown fields stripped).

- [ ] **Step 3: Implement**

In `task.ts`: extend `BaseParameterFields` with `isolation` and `cleanup` Schema literals as above. Resolve effective isolation as `params.isolation ?? agent.isolation ?? "inherit"`. When effective isolation is `"worktree"`, yield `Worktree.Service` (bind to a named variable first), call `createDisposable({ sessionID: ctx.sessionID })`, and pass the returned `info.directory` as the child session `directory` in `sessions.create`. Attach metadata `{ worktree: info.directory, disposable: effectiveCleanup === "dispose" }`. In `subagent-permissions.ts`: accept optional `sandbox` input and append `{ permission: "external_directory", pattern: sandbox, action: "allow" }`-style scoping only when provided; keep existing deny/task/todo merge untouched. Child sessions still respect `subagent_depth` and the existing `ctx.ask` permission prompt. Never reuse a prompt message ID; fresh child session per spawn.

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/opencode`: `bun test test/tool/task-isolation.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run from `packages/opencode`: `bun typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

Exact commit message: `feat(task): run subagents in temp worktrees`

### Task 6: Handoff rebinds session directory plus dispose-on-archive

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts`
- Modify: `packages/opencode/src/session/session.ts`
- Test: existing worktree handler tests if present (`glob test/**/experimental*.test.ts` and `test/session/*.test.ts` from `packages/opencode`); otherwise add `packages/opencode/test/worktree/handoff-rebind.test.ts` exercising `shouldDispose` + directory rebind decision logic

**Interfaces:**
- Consumes: `HandoffInput { from, to }` plus session id from route context
- Produces: `boolean` plus updated session `directory`; disposable source worktree disposed when idle after rebind

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { shouldDispose } from "../../src/worktree/session-binding"

describe("handoff rebind", () => {
  test("source disposable worktree is eligible for disposal after handoff completes", () => {
    const binding = { sessionID: "ses_1", directory: "/w/old", disposable: true }
    expect(shouldDispose(binding, { archived: false, running: false })).toBe(false)
    expect(shouldDispose({ ...binding }, { archived: true, running: false })).toBe(true)
  })
})
```

Extend with a session-directory rebinding assertion against the real `Session.create`/`Session.get` round-trip in the test setup used by `packages/core/test/session-create.test.ts` (project row with `worktree`, then create session, then update directory to handoff target and assert `get` returns the new directory).

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/opencode`: `bun test test/worktree/handoff-rebind.test.ts`
Expected: FAIL until the handler rebinds the session row (directory unchanged after handoff).

- [ ] **Step 3: Implement**

In `handlers/experimental.ts` `worktreeHandoff`: after `worktreeSvc.handoff(ctx.payload)` succeeds, update the calling session's `directory` to the canonicalized `to` path and call `project.addSandbox` for the target (the service already does this; keep it). In `session.ts`: use the `session-binding` helper to decide whether the source directory is disposable and idle, and if so call `disposeIfIdle({ directory: from })` without failing the handoff when disposal is skipped. Preserve the guards already in the service: same-path handoff fails, missing target fails, non-git fails.

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/opencode`: `bun test test/worktree/handoff-rebind.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run from `packages/opencode`: `bun typecheck`
Expected: exit 0. If the HttpApi surface changed (new `worktreeDispose` endpoint), run `bun run generate` from `packages/client` and assert `git status --porcelain packages/client/src` shows only regenerated files.

- [ ] **Step 6: Commit**

Exact commit message: `feat(worktree): rebind session on handoff with dispose`

### Task 7: New-session disposable option plus sidebar remove/reset/handoff

**Files:**
- Modify: `packages/app/src/pages/new-session/new-session-workspace-controller.ts`
- Modify: `packages/app/src/pages/new-session/new-session-draft-controller.ts`
- Modify: `packages/app/src/pages/layout/sidebar-workspace.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Test: `packages/app/src/pages/new-session/new-session-worktree-controller.test.ts`, `packages/app/src/pages/layout/sidebar-worktree-menu.test.ts`

**Interfaces:**
- Consumes: existing workspace selection (`main | create | <existing>`), worktree list endpoint, session directory
- Produces: new `disposable` selection creating via `worktree.create` then session create in the returned directory; sidebar menu actions calling existing SDK `worktreeCreate`/`worktreeRemove`/`worktreeReset`/`worktreeHandoff`; occupied guard via branch info already returned by list

- [ ] **Step 1: Write the failing tests**

In `new-session-worktree-controller.test.ts`, extend the existing `resolveNewSessionWorktree`/`normalizeNewSessionWorktree` cases:

```ts
import { describe, expect, test } from "bun:test"
import { normalizeNewSessionWorktree, resolveNewSessionWorktree } from "./new-session-workspace-controller"

describe("disposable worktree selection", () => {
  test("keeps disposable selection distinct from main and create", () => {
    expect(normalizeNewSessionWorktree("disposable", "/project/feature", "/project")).toBe("disposable")
    expect(resolveNewSessionWorktree({ enabled: true, directory: "/project/feature", projectWorktree: "/project" })).toBe(
      "/project/feature",
    )
  })
})
```

In `sidebar-worktree-menu.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

describe("sidebar worktree menu", () => {
  test("menu model exposes remove, reset, and handoff for sandbox entries", () => {
    const actions = ["session.worktree.remove", "session.worktree.reset", "session.worktree.handoff"]
    expect(actions).toHaveLength(3)
  })
})
```

Replace the placeholder array with the real menu-model function under test once implemented; the failing state is the missing `disposable` normalization and missing menu actions.

- [ ] **Step 2: Run the tests to verify they fail**

Run from `packages/app`: `bun test src/pages/new-session/new-session-worktree-controller.test.ts src/pages/layout/sidebar-worktree-menu.test.ts`
Expected: FAIL (disposable normalized away; menu actions missing).

- [ ] **Step 3: Implement**

Controller: accept `"disposable"` as a first-class selection alongside `"main"` and `"create"`; `normalizeNewSessionWorktree` passes `"disposable"` through; draft controller creates the worktree first via the SDK create call, then creates the session with `directory` set to the returned worktree directory and flags it disposable. Sidebar: add three menu items per sandbox row wired to the existing generated SDK methods, all labels via `language.t(...)` with the keys listed above; show `session.worktree.retainedCount` with `language.plural` semantics where the count key exists, else `language.t("session.worktree.retainedCount", { count, keep })`. Handoff item is disabled with `session.worktree.handoffOccupied` tooltip when the target worktree already backs a running session (use loaded-session check, not new state). Add all ten English keys to `packages/app/src/i18n/en.ts`; extend the `worktree-fallback.ts` key filter only if the new keys do not already start with a covered prefix.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `packages/app`: `bun test src/pages/new-session/new-session-worktree-controller.test.ts src/pages/layout/sidebar-worktree-menu.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run from `packages/app`: `bun typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

Exact commit message: `feat(app): disposable worktrees with handoff menu`

## Verification Checklist

- [ ] `bun test test/worktree/` passes from `packages/opencode`
- [ ] `bun test test/tool/task-isolation.test.ts` passes from `packages/opencode`
- [ ] `bun test test/agent-config.test.ts` passes from `packages/core`
- [ ] New-session plus sidebar menu tests pass from `packages/app`
- [ ] `bun typecheck` clean in `packages/opencode`, `packages/core`, `packages/app`
- [ ] `bun run generate` from `packages/client` produces no diff unless the HttpApi changed, in which case only generated files differ
- [ ] No hardcoded English copy in modified UI files (`grep -n "language.t" ` covers every new label)
- [ ] No `any`, no star imports, no aliased imports in new/modified files
