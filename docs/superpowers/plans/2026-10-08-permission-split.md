# WS4 Permission Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Flynncode's conflated permission ruleset into an enforced sandbox axis (where tools may act) and a consent approval axis (when they must ask), with a non-mutating auto-approve reviewer.

**Architecture:** Server owns both axes: `sandbox.ts` resolves a per-session sandbox level and enforces path containment inside tool execution before any permission ask; `permission/index.ts` keeps deny>ask>allow evaluation but threads a session approval mode through `ask()` so auto/acceptEdits short-circuit without touching the sandbox; a synchronous `reviewer.ts` classifier auto-allows only low-risk boundary crossings. UI renders the two axes in separate dock slots behind i18n keys.

**Tech Stack:** Bun + TypeScript, Effect (Effect.fn named traces, InstanceState, Schema.Class/TaggedErrorClass), SolidJS app UI with `@solid-primitives/i18n` keys, `bun:test` + `testEffect` harness, `bun typecheck` (`tsgo --noEmit`) per package.

## Global Constraints

- Keep UI copy behind i18n keys: never hardcode user-visible English in production code; add keys to `packages/app/src/i18n/en.ts` and read via `language.t(...)`.
- No `any` type anywhere; use `Schema.Unknown`/`Schema.Json` for opaque values and narrow at the consumer.
- No star imports (`import * as Foo`) and no aliased imports (`import { foo as bar }`); import the module's own exported namespace by name (e.g. `import { Permission } from "@/permission"`).
- Conventional commits only: `type(scope): summary` with types `feat|fix|docs|chore|refactor|test`.
- Run tests from package dirs (never repo root): `bun test <path>` inside `packages/opencode` or `packages/app`.
- Run `bun typecheck` from the touched package dir after every task; never `tsc` directly.
- Backends self-hosted or user-owned only; no vendor-hosted clouds, Sites hosting, or voice products in scope.
- Sandbox enforcement is local path containment (worktree + registered sandboxes); no new daemon, no OS seatbelt/bubblewrap bindings in this workstream.

---

### Task 1: Sandbox + approval-mode config schema

**Files:**
- Modify: `packages/core/src/v1/config/permission.ts`
- Modify: `packages/opencode/src/permission/index.ts` (only the `fromConfig` loop entry line)
- Test: `packages/opencode/test/permission/sandbox-config.test.ts` (create)

**Interfaces:**
- Consumes: existing `ConfigPermissionV1.Info`, `Action`, `Rule` schemas.
- Produces: `SandboxMode` (`"readonly" | "workspace-write" | "full-access"`), `ApprovalMode` (`"manual" | "accept-edits" | "auto"`), `SessionPolicy` struct `{ sandbox: SandboxMode, approval: ApprovalMode }` exported from `@opencode-ai/core/v1/config/permission`; `resolveSessionPolicy(raw: unknown): SessionPolicy` pure helper in the same module.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"

test("resolveSessionPolicy defaults to workspace-write/manual", () => {
  const policy = ConfigPermissionV1.resolveSessionPolicy({})
  expect(policy).toEqual({ sandbox: "workspace-write", approval: "manual" })
})

test("resolveSessionPolicy reads explicit modes", () => {
  const policy = ConfigPermissionV1.resolveSessionPolicy({ sandbox: "readonly", approval: "auto" })
  expect(policy).toEqual({ sandbox: "readonly", approval: "auto" })
})

test("resolveSessionPolicy rejects unknown sandbox", () => {
  expect(() => ConfigPermissionV1.resolveSessionPolicy({ sandbox: "yolo" })).toThrow()
})

test("resolveSessionPolicy ignores tool rules when reading policy", () => {
  const policy = ConfigPermissionV1.resolveSessionPolicy({ sandbox: "readonly", bash: "ask" })
  expect(policy).toEqual({ sandbox: "readonly", approval: "manual" })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/permission/sandbox-config.test.ts` (in `packages/opencode`)
Expected: FAIL with "resolveSessionPolicy is not a function"

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/v1/config/permission.ts` (keep existing exports untouched):

```ts
export const SandboxMode = Schema.Literals(["readonly", "workspace-write", "full-access"]).annotate({
  identifier: "SandboxMode",
})
export type SandboxMode = Schema.Schema.Type<typeof SandboxMode>

export const ApprovalMode = Schema.Literals(["manual", "accept-edits", "auto"]).annotate({
  identifier: "ApprovalMode",
})
export type ApprovalMode = Schema.Schema.Type<typeof ApprovalMode>

export const SessionPolicy = Schema.Struct({
  sandbox: Schema.optional(SandboxMode).pipe(Schema.withDecodingDefault(() => "workspace-write" as const)),
  approval: Schema.optional(ApprovalMode).pipe(Schema.withDecodingDefault(() => "manual" as const)),
}).annotate({ identifier: "SessionPolicy" })
export type SessionPolicy = Schema.Schema.Type<typeof SessionPolicy>

export function resolveSessionPolicy(raw: unknown): { sandbox: SandboxMode; approval: ApprovalMode } {
  const record = (raw ?? {}) as Record<string, unknown>
  const decoded = Schema.decodeUnknownSync(SessionPolicy)({
    sandbox: record.sandbox,
    approval: record.approval,
  })
  return { sandbox: decoded.sandbox, approval: decoded.approval }
}

const RESERVED_POLICY_KEYS = ["sandbox", "approval"]

export function stripPolicyKeys(raw: unknown): Record<string, unknown> {
  const record = (raw ?? {}) as Record<string, unknown>
  return Object.fromEntries(Object.entries(record).filter(([key]) => !RESERVED_POLICY_KEYS.includes(key)))
}

export * as ConfigPermissionV1 from "./permission"
```

Note: the file already ends with `export * as ConfigPermissionV1 from "./permission"` self-reexport; add new exports above that line, do not duplicate it. Validate rejection via Schema decode throw (no try/catch in test needed; `toThrow` asserts it).

Then update `Permission.fromConfig` in `packages/opencode/src/permission/index.ts` to strip reserved keys on entry (one-line change inside that function, full test in Task 3):

```ts
export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(ConfigPermissionV1.stripPolicyKeys(permission))) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/permission/sandbox-config.test.ts` (in `packages/opencode`)
Expected: PASS (4 tests)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/permission/sandbox-config.test.ts` (in `packages/opencode`)
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck**

Run: `bun typecheck` (in `packages/opencode`)
Expected: exit 0, no errors

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/v1/config/permission.ts packages/opencode/src/permission/index.ts packages/opencode/test/permission/sandbox-config.test.ts
git commit -m "feat(core): add sandbox and approval mode policy schema"
```

---

### Task 2: Server sandbox resolver + path containment

**Files:**
- Create: `packages/opencode/src/permission/sandbox.ts`
- Test: `packages/opencode/test/permission/sandbox.test.ts` (create)

**Interfaces:**
- Consumes: `ConfigPermissionV1.SandboxMode`, worktree root string, sandbox dir list (`string[]` from `Project.sandboxes`).
- Produces: `Sandbox` namespace with `resolveLevel(raw: unknown): SandboxMode`, `isPathAllowed(path: string, root: string, sandboxes: string[], level: SandboxMode): boolean`, `SandboxViolationError extends Schema.TaggedErrorClass` (fields: `path`, `level`).

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"
import { Sandbox } from "../../src/permission/sandbox"

test("workspace-write allows worktree paths, denies outside", () => {
  expect(Sandbox.isPathAllowed("/repo/src/a.ts", "/repo", [], "workspace-write")).toBe(true)
  expect(Sandbox.isPathAllowed("/etc/passwd", "/repo", [], "workspace-write")).toBe(false)
})

test("workspace-write allows registered sandbox dirs", () => {
  expect(Sandbox.isPathAllowed("/tmp/wt-1/f.ts", "/repo", ["/tmp/wt-1"], "workspace-write")).toBe(true)
})

test("readonly denies writes everywhere", () => {
  expect(Sandbox.isPathAllowed("/repo/src/a.ts", "/repo", [], "readonly")).toBe(false)
})

test("full-access allows everything", () => {
  expect(Sandbox.isPathAllowed("/etc/passwd", "/repo", [], "full-access")).toBe(true)
})

test("resolveLevel defaults to workspace-write", () => {
  expect(Sandbox.resolveLevel(undefined)).toBe("workspace-write")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/permission/sandbox.test.ts` (in `packages/opencode`)
Expected: FAIL with "Cannot find module '../../src/permission/sandbox'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/opencode/src/permission/sandbox.ts`:

```ts
import { Schema } from "effect"
import path from "path"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"

export class SandboxViolationError extends Schema.TaggedErrorClass<SandboxViolationError>()(
  "SandboxViolationError",
  {
    path: Schema.String,
    level: ConfigPermissionV1.SandboxMode,
  },
) {}

function contains(root: string, target: string) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

export function resolveLevel(raw: unknown): ConfigPermissionV1.SandboxMode {
  if (raw === undefined) return "workspace-write"
  return Schema.decodeUnknownSync(ConfigPermissionV1.SandboxMode)(raw)
}

export function isPathAllowed(target: string, root: string, sandboxes: string[], level: ConfigPermissionV1.SandboxMode): boolean {
  if (level === "full-access") return true
  if (level === "readonly") return false
  if (contains(root, target)) return true
  return sandboxes.some((dir) => contains(dir, target))
}

export * as Sandbox from "./sandbox"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/permission/sandbox.test.ts` (in `packages/opencode`)
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck**

Run: `bun typecheck` (in `packages/opencode`)
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/permission/sandbox.ts packages/opencode/test/permission/sandbox.test.ts
git commit -m "feat(opencode): add sandbox path containment resolver"
```

---

### Task 3: Thread approval mode through permission ask (deny>ask>allow preserved)

**Files:**
- Modify: `packages/opencode/src/permission/index.ts`
- Test: `packages/opencode/test/permission/approval-mode.test.ts` (create)

**Interfaces:**
- Consumes: `ConfigPermissionV1.ApprovalMode`, existing `Permission.Service.ask` / `reply` / `list`, existing `PermissionV1.AskInput`.
- Produces: `ask()` accepts optional `approval` field (`ApprovalMode`, default `"manual"`); behavior: `deny` still fails first; `auto` resolves without prompting; `accept-edits` auto-resolves `edit`/`read`/`glob`/`grep`/`list` permissions and prompts the rest; `manual` keeps current behavior byte-for-byte.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

it.instance("auto approval resolves without prompting", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    yield* permission.ask({
      sessionID: SessionID.make("session_test"),
      permission: "bash",
      patterns: ["npm run build"],
      metadata: {},
      always: [],
      ruleset: [],
      approval: "auto",
    })
    const pending = yield* permission.list()
    expect(pending.length).toBe(0)
  }),
)

it.instance("accept-edits auto-resolves edit but prompts bash", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    yield* permission.ask({
      sessionID: SessionID.make("session_test"),
      permission: "edit",
      patterns: ["src/a.ts"],
      metadata: {},
      always: [],
      ruleset: [],
      approval: "accept-edits",
    })
    expect((yield* permission.list()).length).toBe(0)
    const fiber = yield* Effect.fork(
      permission.ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["rm -rf /tmp/x"],
        metadata: {},
        always: [],
        ruleset: [],
        approval: "accept-edits",
      }),
    )
    yield* Effect.sleep("50 millis")
    expect((yield* permission.list()).length).toBe(1)
    yield* fiber.pipe(Effect.interrupt)
  }),
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/permission/approval-mode.test.ts` (in `packages/opencode`)
Expected: FAIL (type error: `approval` does not exist on AskInput, or auto still prompts)

- [ ] **Step 3: Write minimal implementation**

In `packages/opencode/src/permission/index.ts`:
1. Extend the ask input type: change `Interface["ask"]` signature to accept `PermissionV1.AskInput & { approval?: ConfigPermissionV1.ApprovalMode }`. Import `ConfigPermissionV1` from `@opencode-ai/core/v1/config/permission` (no alias, no star).
2. At the top of the `ask` effect, after destructuring `input`, read `input.approval ?? "manual"`.
3. After the deny loop and before creating the pending request, insert the short-circuit (keep deny loop untouched so deny>ask>allow precedence is preserved):

```ts
const AUTO_EDIT_PERMISSIONS = ["edit", "read", "glob", "grep", "list"]
if (approval === "auto") return
if (approval === "accept-edits" && AUTO_EDIT_PERMISSIONS.includes(request.permission)) return
```

4. Strip `approval` from the object before building `info: PermissionV1.Request` (pick fields explicitly; do not spread `input` into `info`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/permission/approval-mode.test.ts test/permission/next.test.ts` (in `packages/opencode`)
Expected: PASS (all suites; `next.test.ts` guards the unchanged manual path)

- [ ] **Step 5: Typecheck**

Run: `bun typecheck` (in `packages/opencode`)
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/permission/index.ts packages/opencode/test/permission/approval-mode.test.ts
git commit -m "feat(opencode): thread approval mode through permission ask"
```

---

### Task 4: Enforce sandbox in tool execution + non-mutating reviewer

**Files:**
- Create: `packages/opencode/src/permission/reviewer.ts`
- Modify: `packages/opencode/src/session/tools.ts`
- Test: `packages/opencode/test/permission/reviewer.test.ts` (create)

**Interfaces:**
- Consumes: `Sandbox.isPathAllowed`, `Permission.Service.ask` with `approval`, session worktree root + sandbox dirs, tool permission name + patterns.
- Produces: `Reviewer.review(input: { permission: string; patterns: string[] }): "allow" | "defer"` pure function; `tools.ts` context `ask` enforces sandbox first (throws `SandboxViolationError` for contained-out paths on `edit`/`bash`/`external_directory`), then delegates to reviewer (auto-allow on `allow`, else permission ask).

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"
import { Reviewer } from "../../src/permission/reviewer"

test("reviewer allows read-only crossings", () => {
  expect(Reviewer.review({ permission: "read", patterns: ["src/a.ts"] })).toBe("allow")
  expect(Reviewer.review({ permission: "glob", patterns: ["**/*.ts"] })).toBe("allow")
  expect(Reviewer.review({ permission: "grep", patterns: ["TODO"] })).toBe("allow")
})

test("reviewer defers mutations and shell", () => {
  expect(Reviewer.review({ permission: "edit", patterns: ["src/a.ts"] })).toBe("defer")
  expect(Reviewer.review({ permission: "bash", patterns: ["npm run build"] })).toBe("defer")
})

test("reviewer never allows archive or destructive shell", () => {
  expect(Reviewer.review({ permission: "archive", patterns: ["*"] })).toBe("defer")
  expect(Reviewer.review({ permission: "bash", patterns: ["rm -rf /"] })).toBe("defer")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/permission/reviewer.test.ts` (in `packages/opencode`)
Expected: FAIL with "Cannot find module '../../src/permission/reviewer'"

- [ ] **Step 3: Write reviewer implementation**

Create `packages/opencode/src/permission/reviewer.ts`:

```ts
const AUTO_ALLOW = ["read", "glob", "grep", "list", "webfetch", "websearch", "lsp"]

export function review(input: { permission: string; patterns: string[] }): "allow" | "defer" {
  if (AUTO_ALLOW.includes(input.permission)) return "allow"
  return "defer"
}

export * as Reviewer from "./reviewer"
```

- [ ] **Step 4: Wire sandbox + reviewer into `session/tools.ts`**

In `packages/opencode/src/session/tools.ts`, inside `resolve`:
1. Add two service yields next to the existing ones (`const permission = yield* Permission.Service` block): `const config = yield* Config.Service` importing `Config` from `@/config/config`, and `const project = yield* Project.Service` importing `Project` from `@/project/project`. Run `bun typecheck` after; if the layer graph lacks either service, add it to the session layer deps alongside the existing service nodes and re-run.
2. Before the `context()` definition, resolve the policy once per session:

```ts
const cfg = yield* config.get()
const policy = ConfigPermissionV1.resolveSessionPolicy(cfg.permission ?? {})
const sandboxDirs = yield* project.sandboxes(input.session.projectID).pipe(Effect.catch(() => Effect.succeed([] as string[])))
```

Import `ConfigPermissionV1` from `@opencode-ai/core/v1/config/permission`, `Sandbox` from `@/permission/sandbox`, `Reviewer` from `@/permission/reviewer`. No star imports, no aliases.

3. Replace the `ask` closure body (lines ~81-89) with:

```ts
ask: (req) =>
  permission
    .ask({
      ...req,
      sessionID: input.session.id,
      tool: { messageID: input.processor.message.id, callID: options.toolCallId },
      ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
      approval: policy.approval,
    })
    .pipe(Effect.orDie),
```

with sandbox + reviewer gating inserted before it for path-bearing tools only (`edit`, `bash`, `external_directory`):

```ts
ask: (req) => {
  const ruleset = Permission.merge(input.agent.permission, input.session.permission ?? [])
  if (req.permission === "edit" || req.permission === "bash" || req.permission === "external_directory") {
    const target = req.patterns[0] ?? ""
    if (target !== "" && !Sandbox.isPathAllowed(target, input.session.directory, sandboxDirs, policy.sandbox)) {
      return Effect.orDie(Effect.fail(new Sandbox.SandboxViolationError({ path: target, level: policy.sandbox })))
    }
  }
  const denied = req.patterns.some(
    (pattern) => Permission.evaluate(req.permission, pattern, ruleset).action === "deny",
  )
  if (!denied && Reviewer.review({ permission: req.permission, patterns: req.patterns }) === "allow") {
    return Effect.orDie(Effect.void)
  }
  return permission
    .ask({
      ...req,
      sessionID: input.session.id,
      tool: { messageID: input.processor.message.id, callID: options.toolCallId },
      ruleset,
      approval: policy.approval,
    })
    .pipe(Effect.orDie)
},
```

Rules: deny always wins (checked first via `Permission.evaluate`, matching the deny>ask>allow order in `ask()`); sandbox violations fail before any prompt with `SandboxViolationError` (distinct from `DeniedError` so UI renders the blocked-by-sandbox copy); reviewer auto-allow never fires when a deny rule matches; reviewer never widens the sandbox (containment runs first).

- [ ] **Step 5: Run tests**

Run: `bun test test/permission/reviewer.test.ts test/permission/sandbox.test.ts test/permission/next.test.ts test/permission/approval-mode.test.ts` (in `packages/opencode`)
Expected: PASS all suites

- [ ] **Step 6: Typecheck**

Run: `bun typecheck` (in `packages/opencode`)
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/permission/reviewer.ts packages/opencode/src/session/tools.ts packages/opencode/test/permission/reviewer.test.ts
git commit -m "feat(opencode): enforce sandbox and reviewer in tool execution"
```

---

### Task 5: Split permission dock UI (sandbox badge + approval controls + mode selector)

**Files:**
- Modify: `packages/app/src/i18n/en.ts`
- Modify: `packages/app/src/pages/session/composer/session-permission-dock.tsx`
- Modify: `packages/app/src/context/permission.tsx`
- Test: `packages/app/src/pages/session/composer/session-permission-dock.test.tsx` (create; follow existing `*.test.ts` colocated pattern with `bun:test`)

**Interfaces:**
- Consumes: `PermissionRequest` (existing), session sandbox level + approval mode (new optional props / context getters), `language.t(...)` keys.
- Produces: dock renders `sandbox` slot (badge) separately from `approval` slot (deny/allowAlways/allowOnce buttons); mode selector cycles `manual → accept-edits → auto`; full-access sandbox requires explicit enable (never default).

- [ ] **Step 1: Add i18n keys to `packages/app/src/i18n/en.ts`**

Append inside the exported `dict` object (find the `"ui.permission.allowOnce"` entry and add after it):

```ts
"sandbox.badge.readonly": "Sandbox: read-only",
"sandbox.badge.workspace": "Sandbox: workspace",
"sandbox.badge.full": "Sandbox: full access",
"approval.mode.manual": "Manual approvals",
"approval.mode.acceptEdits": "Accept edits",
"approval.mode.auto": "Auto approve",
"approval.sandboxBlocked.title": "Blocked by sandbox",
"approval.sandboxBlocked.description": "This action targets a path outside the session sandbox.",
"approval.reviewerApproved.note": "Auto-approved by reviewer",
```

- [ ] **Step 2: Write the failing UI test**

```ts
import { test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

test("permission dock separates sandbox badge from approval actions", async () => {
  const source = await readFile(path.join(import.meta.dir, "session-permission-dock.tsx"), "utf8")
  expect(source).toContain("sandbox.badge.")
  expect(source).toContain("ui.permission.deny")
  expect(source).toContain("approval.mode.")
})

test("english dict carries sandbox and approval keys", async () => {
  const source = await readFile(path.join(import.meta.dir, "..", "..", "..", "i18n", "en.ts"), "utf8")
  expect(source).toContain("sandbox.badge.readonly")
  expect(source).toContain("approval.mode.auto")
  expect(source).toContain("approval.sandboxBlocked.title")
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/pages/session/composer/session-permission-dock.test.tsx` (in `packages/app`)
Expected: FAIL (file missing keys / test file missing before creation — create test first, run, see assertion fail on dock source)

- [ ] **Step 4: Modify the dock**

In `packages/app/src/pages/session/composer/session-permission-dock.tsx`: extend props with `sandbox: "readonly" | "workspace-write" | "full-access"`, `approvalMode: "manual" | "accept-edits" | "auto"`, `blockedBySandbox: boolean`, `reviewerApproved: boolean`, `onModeChange: (mode: ...) => void`. Render order: (1) sandbox badge row using `sandbox.badge.*` key selected by prop, (2) when `blockedBySandbox`, render `approval.sandboxBlocked.title` + `description` instead of action buttons, (3) otherwise existing deny/allowAlways/allowOnce buttons unchanged, (4) mode selector button cycling modes with `approval.mode.*` label, (5) when `reviewerApproved`, render `approval.reviewerApproved.note` hint row. All copy via `language.t(...)`; no hardcoded English.

In `packages/app/src/context/permission.tsx`: add persisted `approvalMode` per session key (mirror the existing `autoAccept` store pattern with `acceptKey(sessionID, directory)` keys; values `"manual" | "accept-edits" | "auto"`, default `"manual"`). Extend `shouldAutoRespond` so `auto` returns true for every permission and `accept-edits` returns true when `["edit", "read", "glob", "grep", "list"].includes(permission.permission)` (same family as the server `AUTO_EDIT_PERMISSIONS` in Task 3), otherwise fall through to the existing `autoAccept` logic. Add `sandboxLevel(directory)`: read `childStore.config.permission` exactly like the existing `isPermissionAllowAll` does, return `(permission as Record<string, string>).sandbox ?? "workspace-write"` typed as `"readonly" | "workspace-write" | "full-access"`. Expose `approvalMode(sessionID, directory)`, `setApprovalMode(sessionID, directory, mode)`, `sandboxLevel(directory)`. Full-access is never set implicitly: only an explicit `setApprovalMode`/sandbox setter writes `"full-access"`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/pages/session/composer/session-permission-dock.test.tsx` (in `packages/app`)
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `bun typecheck` (in `packages/app`)
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/i18n/en.ts packages/app/src/pages/session/composer/session-permission-dock.tsx packages/app/src/context/permission.tsx packages/app/src/pages/session/composer/session-permission-dock.test.tsx
git commit -m "feat(app): split sandbox badge from approval controls"
```

---

### Task 6: Full verification pass

**Files:** none (verification only; fix fallout in place, one commit per fix).

- [ ] **Step 1: Run opencode permission tests**

Run: `bun test test/permission/` (in `packages/opencode`)
Expected: PASS, 0 failures

- [ ] **Step 2: Run app tests for touched areas**

Run: `bun test src/pages/session/composer/ src/context/permission-auto-respond.test.ts` (in `packages/app`; if `permission-auto-respond.test.ts` does not exist, run `bun test src/pages/session/composer/ src/context/` instead)
Expected: PASS, 0 failures

- [ ] **Step 3: Typecheck both packages**

Run: `bun typecheck` (in `packages/opencode`), then `bun typecheck` (in `packages/app`)
Expected: exit 0 in both

- [ ] **Step 4: Commit any fallout fixes** (only if failures occurred)

```bash
git add -A
git commit -m "fix(permission-split): address verification fallout"
```

If no fallout, skip this commit and note "no fallout" in the handoff.
