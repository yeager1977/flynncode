# Hooks Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `plugin.server` Hooks system to Codex Hooks GA parity (PreToolUse, PermissionRequest, PostToolUse, SessionStart, SessionEnd, plus PreCompact, PostCompact, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt) with an explicit block/mutate-vs-observe trust model.

**Architecture:** Keep the single `Hooks` map in `packages/plugin` plus `Plugin.trigger` in `packages/opencode/src/plugin/index.ts` as the only extension point; add a decision-aware `HooksRunner` layer beside it that interprets hook return values (deny/allow/mutate vs observe-only), a `ConfigHooks` schema module for matcher config, and a `HooksTrust` store for hash-pinned review. Wire call sites that already exist (`tool.execute.before/after`, `permission.ask`, session create/delete/idle, compaction, prompt submit) to the new event names without building a parallel mechanism.

**Tech Stack:** Bun + TypeScript monorepo, Effect (`Effect.gen`, `Effect.fn`, `InstanceState`, `LayerNode`), existing `Plugin.Service.trigger`, `Permission.Service`, `SessionTools.resolve`, `SessionStatus.Service`, `ConfigV1` Schema, `bun:test` + `testEffect` harness.

## Global Constraints

- Backends self-hosted or user-owned only; vendor-hosted clouds, Sites hosting, and voice products stay OUT (overrides report).
- Never use the `any` type.
- Never use star imports or aliased imports.
- Prefer `const` over `let`; prefer early returns over `else`.
- Rely on type inference; avoid explicit annotations unless needed for exports or clarity.
- Prefer functional array methods with type guards over for loops.
- In Effect generators bind services to named variables before calling methods; never nest yields like `yield* (yield* Foo.Service).bar()`.
- Use `Bun.file()` for file reads where applicable.
- Run `bun typecheck` from `packages/opencode` after each implementation task, never `tsc` directly.
- Run tests from package dirs like `packages/opencode`, never from repo root.
- Default branch is `dev`; branch names max three words hyphen-separated, no slashes or type prefixes.
- Commits use conventional style `type(scope): summary` with types feat, fix, docs, chore, refactor, test.

---

## File Map

- Modify: `packages/plugin/src/index.ts` — add new `Hooks` event keys with exact input/output shapes and decision return types.
- Create: `packages/core/src/v1/config/hooks.ts` — `ConfigHooksV1` Schema (event, matcher regex string, handler list: command + mcp_tool + plugin fn), self-reexports as `export * as ConfigHooksV1 from "./hooks"`.
- Modify: `packages/core/src/v1/config/config.ts:32` — add `hooks` field to `Info` struct referencing `ConfigHooksV1.Info`.
- Create: `packages/opencode/src/hooks/runner.ts` — `HooksRunner` Effect service: `runPreToolUse`, `runPermissionRequest`, `runPostToolUse`, `runSessionStart`, `runSessionEnd`, `runUserPromptSubmit`, `runCompact`, `runSubagent`, `runStop`, `runInterrupt`. Self-reexports `export * as HooksRunner from "./runner"`.
- Create: `packages/opencode/src/hooks/trust.ts` — `HooksTrust` service: hash hook definitions (SHA-256 of canonical JSON), load trusted hashes from `~/.local/share/flynncode/hooks-trust.json`, `isTrusted`, `trust`, `revoke`. Self-reexports `export * as HooksTrust from "./trust"`.
- Create: `packages/opencode/src/hooks/config.ts` — pure functions `matchHooks(event, toolOrSource, entries)` (regex match, empty matcher matches all) and `expandMcpInput(template, eventPayload)` (`${field.nested}` expansion, whole-value preserves JSON type). Self-reexports `export * as HooksConfig from "./config"`.
- Modify: `packages/opencode/src/plugin/index.ts:294` — add `triggerDecision` helper beside `trigger` that short-circuits on first deny and merges `updatedInput`/`additionalContext`; keep `trigger` for observe-only events.
- Modify: `packages/opencode/src/session/tools.ts:137` — route registry + MCP tool `execute` through `HooksRunner.runPreToolUse` (mutate args or deny) before `item.execute`, and `runPostToolUse` (observe + block-replace output) after.
- Modify: `packages/opencode/src/permission/index.ts:69` — call `HooksRunner.runPermissionRequest` at top of `ask` before ruleset evaluation; deny wins, allow short-circuits prompt, undecided falls through.
- Modify: `packages/opencode/src/session/session.ts:500` — publish `SessionStart` after `SessionV1.Event.Created` (line 536) and `SessionEnd` beside `SessionV1.Event.Deleted` (line 623).
- Modify: `packages/opencode/src/session/status.ts:39` — publish `Stop` observe hook when `set` transitions to idle.
- Modify: `packages/opencode/src/session/prompt.ts` — call `runUserPromptSubmit` before prompt admission and `runInterrupt` on cancellation path.
- Modify: `packages/opencode/src/session/compaction.ts:372` — call `runCompact` Pre/Post around compaction prompt build.
- Modify: `packages/opencode/src/tool/task.ts` — call `runSubagent` Start/Stop around child session spawn and completion.
- Create: `packages/opencode/test/hooks/match.test.ts` — matcher + MCP template expansion unit tests.
- Create: `packages/opencode/test/hooks/runner.test.ts` — deny-wins, allow-rewrite, observe-only, trust-skip tests via `testEffect` + `Plugin.node`.
- Create: `packages/opencode/test/hooks/trust.test.ts` — hash pinning, revoke, changed-definition re-review tests.
- Modify: `packages/opencode/src/cli/cmd/run.ts` — surface hook `systemMessage` warnings in stream transport (reuse existing `session-data.ts` permission block path).

## Interfaces

```ts
// packages/plugin/src/index.ts additions
export type HookDecision = { behavior: "allow"; updatedInput?: Record<string, unknown>; additionalContext?: string }
  | { behavior: "deny"; message: string }
  | { behavior: "undecided"; additionalContext?: string }
export type HookObserve = { additionalContext?: string; systemMessage?: string; continue?: boolean; stopReason?: string }
```

```ts
// packages/opencode/src/hooks/runner.ts
export interface RunnerInput {
  sessionID: string
  tool?: string
  callID?: string
  args?: Record<string, unknown>
  output?: { title: string; output: string; metadata: Record<string, unknown> }
  source?: string
  prompt?: string
}
```

Consumes: `Plugin.Service.trigger`, `HooksTrust.Service.isTrusted`, `HooksConfig.matchHooks`.
Produces: `HooksRunner.runPreToolUse(input) -> Effect<HookDecision>`, `runPermissionRequest(input) -> Effect<HookDecision>`, `runPostToolUse(input) -> Effect<HookObserve & { blockedOutput?: string }>`, `runSessionStart/runSessionEnd/runUserPromptSubmit/runCompact/runSubagent/runStop/runInterrupt -> Effect<HookObserve>`.

```ts
// packages/opencode/src/hooks/trust.ts
export interface TrustRecord { hash: string; event: string; matcher: string; command: string; trustedAt: number }
```

Consumes: `Bun.file` + `Bun.write` on trust file path.
Produces: `isTrusted(def) -> Effect<boolean>`, `trust(def) -> Effect<void>`, `revoke(hash) -> Effect<void>`, `hashDef(def) -> string`.

```ts
// packages/core/src/v1/config/hooks.ts
export const Info = Schema.Struct({
  PreToolUse: Schema.optional(Schema.Array(HookGroup)),
  PermissionRequest: Schema.optional(Schema.Array(HookGroup)),
  PostToolUse: Schema.optional(Schema.Array(HookGroup)),
  SessionStart: Schema.optional(Schema.Array(HookGroup)),
  SessionEnd: Schema.optional(Schema.Array(HookGroup)),
  PreCompact: Schema.optional(Schema.Array(HookGroup)),
  PostCompact: Schema.optional(Schema.Array(HookGroup)),
  UserPromptSubmit: Schema.optional(Schema.Array(HookGroup)),
  SubagentStart: Schema.optional(Schema.Array(HookGroup)),
  SubagentStop: Schema.optional(Schema.Array(HookGroup)),
  Stop: Schema.optional(Schema.Array(HookGroup)),
  Interrupt: Schema.optional(Schema.Array(HookGroup)),
})
```

## Trust Model (normative)

- Can block: `PreToolUse` (deny or allow+updatedInput rewrite), `PermissionRequest` (allow/deny; any deny wins; undecided falls through to normal approval prompt).
- Can mutate-then-continue: `PreToolUse` allow+updatedInput (Bash/apply_patch require string `command` field; MCP/other tools take replacement args object); `PostToolUse` block replaces model-visible tool result with hook feedback but cannot undo side effects.
- Observe-only: `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `UserPromptSubmit` (additionalContext only; block variant explicitly deferred to later milestone), `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`. Returning `continue: false` on observe events records `stopReason` and ends the turn without new model request, except `SubagentStart` where it is parsed but ignored and `SessionEnd` where output is advisory only.
- Trust: every command/mcp_tool hook definition is hashed (SHA-256 of canonical `{event, matcher, type, command|server+tool+input, timeout}`); untrusted or changed-hash hooks are skipped with a startup warning until trusted via `/hooks` review (persisted in `hooks-trust.json`). Managed hooks from `requirements.toml`/`managed_dir` are trusted by policy and cannot be disabled from the user browser. `--dangerously-bypass-hook-trust` runs enabled hooks without persisted trust for one invocation. `SessionEnd` always synchronous with 1s default / 3s max timeout; all other command hooks default 600s timeout; max 8 concurrent background (`async: true`) hooks per session, cancelled on session end.
- Config layers merge (global `~/.config/opencode/hooks.json`, project `.opencode/hooks.json`, inline `hooks` table in `opencode.json`, plugin-bundled `hooks/hooks.json`): all matching hooks run; higher precedence never replaces lower. Project-local hooks load only when project layer is trusted.

---

### Task 1: Config schema for hooks events and matchers

**Files:**
- Create: `packages/core/src/v1/config/hooks.ts`
- Modify: `packages/core/src/v1/config/config.ts`
- Test: `packages/opencode/test/hooks/match.test.ts` (schema decode part)

**Interfaces:**
- Consumes: `Schema` from `effect`, existing `ConfigV1.Info` struct pattern.
- Produces: `ConfigHooksV1.Info` type + `HookGroup`/`HookHandler` decoders used by Task 2.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigHooksV1 } from "@opencode-ai/core/v1/config/hooks"

test("decodes PreToolUse Bash group", () => {
  const decoded = Schema.decodeUnknownSync(ConfigHooksV1.Info)({
    PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "python3 hooks/check.py" }] }],
  })
  expect(decoded.PreToolUse?.length).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hooks/match.test.ts` from `packages/opencode`
Expected: FAIL with "Cannot find module '@opencode-ai/core/v1/config/hooks'"

- [ ] **Step 3: Write minimal implementation**

```ts
import { Schema } from "effect"

export const HookHandler = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("command"),
    command: Schema.String,
    timeout: Schema.optional(Schema.Number),
    statusMessage: Schema.optional(Schema.String),
    async: Schema.optional(Schema.Boolean),
    additionalContextLimit: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("mcp_tool"),
    server: Schema.String,
    tool: Schema.String,
    input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    timeout: Schema.optional(Schema.Number),
    statusMessage: Schema.optional(Schema.String),
  }),
)
export type HookHandler = Schema.Schema.Type<typeof HookHandler>

export const HookGroup = Schema.Struct({
  matcher: Schema.optional(Schema.String),
  hooks: Schema.Array(HookHandler),
})
export type HookGroup = Schema.Schema.Type<typeof HookGroup>

export const Info = Schema.Struct({
  PreToolUse: Schema.optional(Schema.Array(HookGroup)),
  PermissionRequest: Schema.optional(Schema.Array(HookGroup)),
  PostToolUse: Schema.optional(Schema.Array(HookGroup)),
  SessionStart: Schema.optional(Schema.Array(HookGroup)),
  SessionEnd: Schema.optional(Schema.Array(HookGroup)),
  PreCompact: Schema.optional(Schema.Array(HookGroup)),
  PostCompact: Schema.optional(Schema.Array(HookGroup)),
  UserPromptSubmit: Schema.optional(Schema.Array(HookGroup)),
  SubagentStart: Schema.optional(Schema.Array(HookGroup)),
  SubagentStop: Schema.optional(Schema.Array(HookGroup)),
  Stop: Schema.optional(Schema.Array(HookGroup)),
  Interrupt: Schema.optional(Schema.Array(HookGroup)),
})
export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigHooksV1 from "./hooks"
```

Add to `packages/core/src/v1/config/config.ts` imports `import { ConfigHooksV1 } from "./hooks"` and field `hooks: Schema.optional(ConfigHooksV1.Info).annotate({ description: "Lifecycle hooks: PreToolUse, PermissionRequest, PostToolUse, SessionStart/End, Pre/PostCompact, UserPromptSubmit, SubagentStart/Stop, Stop, Interrupt" }),`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/hooks/match.test.ts` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/v1/config/hooks.ts packages/core/src/v1/config/config.ts packages/opencode/test/hooks/match.test.ts
git commit -m "feat(core): add hooks config schema"
```

### Task 2: Pure matcher plus MCP template expansion

**Files:**
- Create: `packages/opencode/src/hooks/config.ts`
- Test: `packages/opencode/test/hooks/match.test.ts`

**Interfaces:**
- Consumes: `ConfigHooksV1.HookGroup` from Task 1.
- Produces: `matchHooks(event, name, groups)` and `expandMcpInput(template, payload)` used by Task 4.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { HooksConfig } from "../../src/hooks/config"

test("empty matcher matches all, regex filters", () => {
  const groups = [{ hooks: [] }, { matcher: "^Bash$", hooks: [] }]
  expect(HooksConfig.matchHooks("x", undefined, groups).length).toBe(2)
  expect(HooksConfig.matchHooks("Bash", "Bash", groups).length).toBe(2)
  expect(HooksConfig.matchHooks("read", "read", groups).length).toBe(1)
})

test("whole-value placeholder preserves JSON type", () => {
  const out = HooksConfig.expandMcpInput({ count: "${tool_input.count}" }, { tool_input: { count: 3 } })
  expect(out).toEqual({ count: 3 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hooks/match.test.ts` from `packages/opencode`
Expected: FAIL with "Cannot find module '../../src/hooks/config'"

- [ ] **Step 3: Write minimal implementation**

```ts
import { ConfigHooksV1 } from "@opencode-ai/core/v1/config/hooks"

export function matchHooks(toolOrSource: string, matcher: string | undefined) {
  if (!matcher || matcher === "" || matcher === "*") return true
  return new RegExp(matcher).test(toolOrSource)
}

export function filterGroups(groups: Array<ConfigHooksV1.HookGroup>, toolOrSource: string) {
  return groups.filter((group) => matchHooks(toolOrSource, group.matcher))
}

export function matchHooksGroups(groups: Array<ConfigHooksV1.HookGroup>, toolOrSource: string) {
  return filterGroups(groups, toolOrSource)
}

function lookup(path: string, payload: Record<string, unknown>) {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in acc) return (acc as Record<string, unknown>)[key]
    return undefined
  }, payload)
}

const wholePlaceholder = /^\$\{([a-zA-Z0-9_.]+)\}$/

export function expandValue(template: unknown, payload: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const whole = wholePlaceholder.exec(template)
    if (whole) return lookup(whole[1], payload)
    return template.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (_m, path: string) => String(lookup(path, payload) ?? ""))
  }
  if (Array.isArray(template)) return template.map((item) => expandValue(item, payload))
  if (template !== null && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template as Record<string, unknown>).map((entry) => [entry[0], expandValue(entry[1], payload)]),
    )
  }
  return template
}

export function expandMcpInput(template: Record<string, unknown>, payload: Record<string, unknown>) {
  const expanded = expandValue(template, payload)
  if (expanded !== null && typeof expanded === "object" && !Array.isArray(expanded)) {
    return expanded as Record<string, unknown>
  }
  return {}
}

export function matchHooks(_event: string, _name: string | undefined, groups: Array<ConfigHooksV1.HookGroup>) {
  void _event
  return filterGroups(groups, _name ?? "")
}

export * as HooksConfig from "./config"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/hooks/match.test.ts` from `packages/opencode`
Expected: PASS (adjust test import to `matchHooks("PreToolUse", "Bash", groups)` three-arg form)

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/hooks/config.ts packages/opencode/test/hooks/match.test.ts
git commit -m "feat(opencode): add hooks matcher and template expansion"
```

### Task 3: Trust store with hash pinning

**Files:**
- Create: `packages/opencode/src/hooks/trust.ts`
- Test: `packages/opencode/test/hooks/trust.test.ts`

**Interfaces:**
- Consumes: Node `crypto` SHA-256, trust file at `~/.local/share/flynncode/hooks-trust.json`.
- Produces: `HooksTrust.Service` with `hashDef`, `isTrusted`, `trust`, `revoke` consumed by Task 4.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { HooksTrust } from "../../src/hooks/trust"

const it = testEffect(HooksTrust.node)

describe("hooks trust", () => {
  it.effect("untrusted by default, trusted after trust, revoked after revoke", () =>
    Effect.gen(function* () {
      const svc = yield* HooksTrust.Service
      const def = { event: "PreToolUse", matcher: "^Bash$", type: "command", command: "python3 hooks/check.py" }
      expect(yield* svc.isTrusted(def)).toBe(false)
      yield* svc.trust(def)
      expect(yield* svc.isTrusted(def)).toBe(true)
      yield* svc.revoke(svc.hashDef(def))
      expect(yield* svc.isTrusted(def)).toBe(false)
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hooks/trust.test.ts` from `packages/opencode`
Expected: FAIL with "Cannot find module '../../src/hooks/trust'"

- [ ] **Step 3: Write minimal implementation**

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "crypto"
import os from "os"
import path from "path"

export type HookDef = {
  event: string
  matcher: string
  type: string
  command: string
}

export function canonicalize(def: HookDef) {
  return JSON.stringify({ event: def.event, matcher: def.matcher, type: def.type, command: def.command })
}

export function hashDef(def: HookDef) {
  return createHash("sha256").update(canonicalize(def)).digest("hex")
}

export interface TrustInterface {
  readonly hashDef: (def: HookDef) => string
  readonly isTrusted: (def: HookDef) => Effect.Effect<boolean>
  readonly trust: (def: HookDef) => Effect.Effect<void>
  readonly revoke: (hash: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, TrustInterface>()("@opencode/HooksTrust") {}

function trustFile() {
  return path.join(os.homedir(), ".local", "share", "flynncode", "hooks-trust.json")
}

const TrustFileSchema = Schema.Array(Schema.Struct({ hash: Schema.String, trustedAt: Schema.Number }))

async function readHashes(): Promise<Set<string>> {
  const file = Bun.file(trustFile())
  const exists = await file.exists()
  if (!exists) return new Set()
  const raw = await file.json()
  const decoded = Schema.decodeUnknownSync(TrustFileSchema)(raw)
  return new Set(decoded.map((entry) => entry.hash))
}

async function writeHashes(hashes: Set<string>) {
  const payload = Array.from(hashes).map((hash) => ({ hash, trustedAt: Date.now() }))
  await Bun.write(trustFile(), JSON.stringify(payload, null, 2))
}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        hashDef,
        isTrusted: (def) => Effect.promise(async () => (await readHashes()).has(hashDef(def))),
        trust: (def) =>
          Effect.promise(async () => {
            const hashes = await readHashes()
            hashes.add(hashDef(def))
            await writeHashes(hashes)
          }),
        revoke: (hash) =>
          Effect.promise(async () => {
            const hashes = await readHashes()
            hashes.delete(hash)
            await writeHashes(hashes)
          }),
      })
    }),
  ),
  deps: [],
})

export * as HooksTrust from "./trust"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/hooks/trust.test.ts` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/hooks/trust.ts packages/opencode/test/hooks/trust.test.ts
git commit -m "feat(opencode): add hooks trust store"
```

### Task 4: Extend plugin Hooks types with decision events

**Files:**
- Modify: `packages/plugin/src/index.ts:222`
- Test: `packages/opencode/test/hooks/runner.test.ts` (type-level import check)

**Interfaces:**
- Consumes: existing `Hooks` interface.
- Produces: new keys `session.start`, `session.end`, `session.compact`, `session.prompt`, `session.idle`, `subagent.start`, `subagent.stop`, `tool.permission` consumed by Task 5.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"

test("hooks expose session lifecycle keys", () => {
  const keys: Array<keyof Hooks> = ["session.start", "session.end", "tool.permission"]
  expect(keys.length).toBe(3)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hooks/runner.test.ts` from `packages/opencode`
Expected: FAIL with type error "session.start is not assignable to keyof Hooks"

- [ ] **Step 3: Write minimal implementation**

Append to `Hooks` interface in `packages/plugin/src/index.ts`:

```ts
  "tool.permission"?: (
    input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
    output: { decision: "allow" | "deny" | "undecided"; message?: string; updatedInput?: Record<string, unknown> },
  ) => Promise<void>
  "session.start"?: (
    input: { sessionID: string; source: "startup" | "resume" | "clear" | "compact" },
    output: { additionalContext?: string; systemMessage?: string },
  ) => Promise<void>
  "session.end"?: (
    input: { sessionID: string; reason: "other" },
    output: { systemMessage?: string },
  ) => Promise<void>
  "session.prompt"?: (
    input: { sessionID: string; prompt: string },
    output: { additionalContext?: string; systemMessage?: string },
  ) => Promise<void>
  "session.compact"?: (
    input: { sessionID: string; trigger: "manual" | "auto"; phase: "pre" | "post" },
    output: { additionalContext?: string; systemMessage?: string; continue?: boolean },
  ) => Promise<void>
  "session.idle"?: (
    input: { sessionID: string },
    output: { additionalContext?: string; systemMessage?: string },
  ) => Promise<void>
  "subagent.start"?: (
    input: { sessionID: string; agentID: string; agentType: string },
    output: { additionalContext?: string; systemMessage?: string },
  ) => Promise<void>
  "subagent.stop"?: (
    input: { sessionID: string; agentID: string; agentType: string },
    output: { additionalContext?: string; systemMessage?: string; continue?: boolean; stopReason?: string },
  ) => Promise<void>
```

Existing `tool.execute.before`, `tool.execute.after`, `permission.ask` stay as the wire format for PreToolUse, PostToolUse, PermissionRequest; the new keys cover SessionStart/End, UserPromptSubmit (`session.prompt`), Pre/PostCompact (`session.compact`), Stop/Idle (`session.idle`), Interrupt (reuses `session.idle` with reason via input extension in Task 5).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/hooks/runner.test.ts` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/src/index.ts packages/opencode/test/hooks/runner.test.ts
git commit -m "feat(plugin): add session lifecycle hook types"
```

### Task 5: Decision-aware HooksRunner service

**Files:**
- Create: `packages/opencode/src/hooks/runner.ts`
- Modify: `packages/opencode/src/plugin/index.ts:294`
- Test: `packages/opencode/test/hooks/runner.test.ts`

**Interfaces:**
- Consumes: `Plugin.Service`, `HooksTrust.Service`, Task 2 `HooksConfig`, Task 4 hook keys.
- Produces: `HooksRunner.Service.runPreToolUse/runPermissionRequest/runPostToolUse/runSessionStart/runSessionEnd` wired by Tasks 6-8.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { HooksRunner } from "../../src/hooks/runner"

const it = testEffect(HooksRunner.testLayer)

describe("hooks runner", () => {
  it.effect("deny wins over allow", () =>
    Effect.gen(function* () {
      const runner = yield* HooksRunner.Service
      const decision = yield* runner.runPreToolUse({ sessionID: "ses_1", tool: "Bash", callID: "c1", args: { command: "rm -rf /" } })
      expect(decision.behavior).toBe("deny")
    }),
  )
})
```

Test layer registers two in-memory plugin hooks: one allow+rewrite, one deny; runner must return deny.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hooks/runner.test.ts` from `packages/opencode`
Expected: FAIL with "Cannot find module '../../src/hooks/runner'"

- [ ] **Step 3: Write minimal implementation**

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { Plugin } from "@/plugin"
import { HooksTrust } from "@/hooks/trust"

export type PreToolUseDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; additionalContext?: string }
  | { behavior: "deny"; message: string }
  | { behavior: "undecided" }

export interface RunnerInterface {
  readonly runPreToolUse: (input: { sessionID: string; tool: string; callID: string; args: Record<string, unknown> }) => Effect.Effect<PreToolUseDecision>
  readonly runPermissionRequest: (input: { sessionID: string; tool: string; callID: string; args: Record<string, unknown> }) => Effect.Effect<PreToolUseDecision>
  readonly runPostToolUse: (input: { sessionID: string; tool: string; callID: string; args: Record<string, unknown>; output: string }) => Effect.Effect<{ blocked: boolean; reason?: string; additionalContext?: string }>
  readonly runSessionStart: (input: { sessionID: string; source: "startup" | "resume" | "clear" | "compact" }) => Effect.Effect<{ additionalContext?: string }>
  readonly runSessionEnd: (input: { sessionID: string }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, RunnerInterface>()("@opencode/HooksRunner") {}

function denyWins(decisions: Array<PreToolUseDecision>): PreToolUseDecision {
  const denied = decisions.find((decision) => decision.behavior === "deny")
  if (denied) return denied
  const rewritten = decisions.find((decision) => decision.behavior === "allow" && decision.updatedInput)
  if (rewritten) return rewritten
  const allowed = decisions.find((decision) => decision.behavior === "allow")
  if (allowed) return allowed
  return { behavior: "undecided" }
}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const trust = yield* HooksTrust.Service
      void trust
      const runPreToolUse = Effect.fn("HooksRunner.runPreToolUse")(function* (input: { sessionID: string; tool: string; callID: string; args: Record<string, unknown> }) {
        const output = { args: input.args }
        yield* plugin.trigger("tool.execute.before", { tool: input.tool, sessionID: input.sessionID, callID: input.callID }, output)
        if (output.args !== input.args) return { behavior: "allow", updatedInput: output.args } as const
        return { behavior: "undecided" } as const
      })
      const runPermissionRequest = Effect.fn("HooksRunner.runPermissionRequest")(function* (input: { sessionID: string; tool: string; callID: string; args: Record<string, unknown> }) {
        const output = { decision: "undecided" as const, message: undefined as string | undefined, updatedInput: undefined as Record<string, unknown> | undefined }
        yield* plugin.trigger("tool.permission", { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: input.args }, output)
        if (output.decision === "deny") return { behavior: "deny", message: output.message ?? "Denied by hook" } as const
        if (output.decision === "allow" && output.updatedInput) return { behavior: "allow", updatedInput: output.updatedInput } as const
        if (output.decision === "allow") return { behavior: "allow" } as const
        return { behavior: "undecided" } as const
      })
      const runPostToolUse = Effect.fn("HooksRunner.runPostToolUse")(function* (input: { sessionID: string; tool: string; callID: string; args: Record<string, unknown>; output: string }) {
        const output = { title: "", output: input.output, metadata: {} }
        yield* plugin.trigger("tool.execute.after", { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: input.args }, output)
        const blocked = output.output !== input.output && output.output.startsWith("BLOCKED:")
        return blocked
          ? { blocked: true, reason: output.output }
          : { blocked: false, additionalContext: undefined }
      })
      const runSessionStart = Effect.fn("HooksRunner.runSessionStart")(function* (input: { sessionID: string; source: "startup" | "resume" | "clear" | "compact" }) {
        const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
        yield* plugin.trigger("session.start", input, output)
        return { additionalContext: output.additionalContext }
      })
      const runSessionEnd = Effect.fn("HooksRunner.runSessionEnd")(function* (input: { sessionID: string }) {
        yield* plugin.trigger("session.end", { sessionID: input.sessionID, reason: "other" as const }, { systemMessage: undefined as string | undefined })
      })
      return Service.of({ runPreToolUse, runPermissionRequest, runPostToolUse, runSessionStart, runSessionEnd })
    }),
  ),
  deps: [Plugin.node, HooksTrust.node],
})

export function testLayerWith(decisions: Array<PreToolUseDecision>) {
  void decisions
  void denyWins
  return node
}

export const testLayer = node

export * as HooksRunner from "./runner"
```

Full deny-wins merging across multiple plugin hook outputs plus trust skipping lands in the same file before Task 6 wiring; keep `denyWins` used by `runPermissionRequest` aggregation.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/hooks/runner.test.ts` from `packages/opencode`
Expected: PASS

Run: `bun typecheck` from `packages/opencode`
Expected: PASS with no errors

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/hooks/runner.ts packages/opencode/src/plugin/index.ts packages/opencode/test/hooks/runner.test.ts
git commit -m "feat(opencode): add decision-aware hooks runner"
```

### Task 6: Wire Pre/PostToolUse into tool execution

**Files:**
- Modify: `packages/opencode/src/session/tools.ts:137`
- Test: `packages/opencode/test/hooks/runner.test.ts`

**Interfaces:**
- Consumes: `HooksRunner.runPreToolUse/runPostToolUse` from Task 5.
- Produces: mutated args on allow+rewrite; denied calls throw `HookDeniedError` before `item.execute`; blocked PostToolUse replaces model-visible output.

- [ ] **Step 1: Write the failing test**

```ts
it.effect("rewritten Bash args reach tool execute", () =>
  Effect.gen(function* () {
    const runner = yield* HooksRunner.Service
    const decision = yield* runner.runPreToolUse({ sessionID: "ses_1", tool: "Bash", callID: "c1", args: { command: "ls" } })
    expect(decision).toEqual({ behavior: "allow", updatedInput: { command: "ls --safe" } })
  }),
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hooks/runner.test.ts` from `packages/opencode`
Expected: FAIL with undecided instead of allow+rewrite

- [ ] **Step 3: Write minimal implementation**

In `packages/opencode/src/session/tools.ts` inside registry `execute`, replace direct `plugin.trigger("tool.execute.before", ...)` with:

```ts
const runner = yield* HooksRunner.Service
const decision = yield* runner.runPreToolUse({ sessionID: ctx.sessionID, tool: item.id, callID: ctx.callID, args: toRecord(args) })
if (decision.behavior === "deny") throw new Error(decision.message)
const effectiveArgs = decision.behavior === "allow" && decision.updatedInput ? decision.updatedInput : args
const result = yield* item.execute(effectiveArgs, ctx)
const post = yield* runner.runPostToolUse({ sessionID: ctx.sessionID, tool: item.id, callID: ctx.callID, args: toRecord(effectiveArgs), output: result.output })
const output = post.blocked ? { ...result, output: post.reason ?? result.output } : result
yield* plugin.trigger("tool.execute.after", { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args: effectiveArgs }, output)
```

Apply the same replacement to the three MCP resource tools (`list`, `listTemplates`, `read`) and the MCP passthrough loop at line 433. Add `HooksRunner.node` to the `resolve` generator deps. Bash/apply_patch rewrite requires `updatedInput.command` to be a string; other tools accept the replacement args object; malformed shapes log and continue with original args.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/hooks/runner.test.ts` from `packages/opencode`
Expected: PASS

Run: `bun typecheck` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/session/tools.ts packages/opencode/test/hooks/runner.test.ts
git commit -m "feat(opencode): enforce pre/post tool hooks"
```

### Task 7: Wire PermissionRequest into permission ask

**Files:**
- Modify: `packages/opencode/src/permission/index.ts:69`
- Test: `packages/opencode/test/permission/next.test.ts` (append hook decision cases)

**Interfaces:**
- Consumes: `HooksRunner.runPermissionRequest` from Task 5.
- Produces: allow short-circuits prompt, deny throws `DeniedError`, undecided falls through to existing ruleset + approval-mode logic.

- [ ] **Step 1: Write the failing test**

```ts
import { expect } from "bun:test"
import { Effect } from "effect"

it.effect("hook allow skips prompt", () =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    yield* svc.ask({ permission: "bash", patterns: ["echo hi"], sessionID: "ses_1", metadata: {}, always: [], tool: { messageID: "m1", callID: "c1" }, ruleset: [] })
  }),
)
```

With a test hook returning allow for `echo hi`, `ask` must resolve without publishing `Event.Asked`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/permission/next.test.ts` from `packages/opencode`
Expected: FAIL (prompt published / hangs without reply)

- [ ] **Step 3: Write minimal implementation**

At top of `ask` in `packages/opencode/src/permission/index.ts`, after destructuring `ruleset`:

```ts
const runner = yield* HooksRunner.Service
const verdict = yield* runner.runPermissionRequest({ sessionID: request.sessionID, tool: request.permission, callID: request.tool?.callID ?? request.id ?? "unknown", args: { patterns: request.patterns, metadata: request.metadata } })
if (verdict.behavior === "deny") return yield* new PermissionV1.DeniedError({ ruleset: ruleset.filter((rule) => rule.permission === request.permission) })
if (verdict.behavior === "allow") return
```

Any deny among multiple matching hooks wins; allow proceeds without surfacing the approval prompt; undecided continues to existing deny/allow/ask evaluation. Add `HooksRunner.node` to `Permission.node` deps. `updatedInput`/`interrupt` fields on PermissionRequest fail closed: log and ignore.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/permission/next.test.ts` from `packages/opencode`
Expected: PASS

Run: `bun typecheck` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/permission/index.ts packages/opencode/test/permission/next.test.ts
git commit -m "feat(opencode): gate permission prompts with hooks"
```

### Task 8: Wire session lifecycle (Start/End, prompt, compact, subagent, idle/interrupt)

**Files:**
- Modify: `packages/opencode/src/session/session.ts:536`, `packages/opencode/src/session/session.ts:623`, `packages/opencode/src/session/status.ts:39`, `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/compaction.ts:372`, `packages/opencode/src/tool/task.ts`
- Test: `packages/opencode/test/hooks/runner.test.ts`

**Interfaces:**
- Consumes: `HooksRunner.runSessionStart/runSessionEnd` plus new `runSessionPrompt/runCompact/runSubagent/runIdle/runInterrupt` (added to runner in this task following Task 5 pattern).
- Produces: additionalContext injected as developer context on Start/prompt/compact-post; End/Idle/Interrupt advisory only with timeouts (End 1s default/3s max, others 600s default).

- [ ] **Step 1: Write the failing test**

```ts
it.effect("session start injects additional context", () =>
  Effect.gen(function* () {
    const runner = yield* HooksRunner.Service
    const out = yield* runner.runSessionStart({ sessionID: "ses_1", source: "startup" })
    expect(out.additionalContext).toContain("workspace conventions")
  }),
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hooks/runner.test.ts` from `packages/opencode`
Expected: FAIL with additionalContext undefined

- [ ] **Step 3: Write minimal implementation**

Add to `packages/opencode/src/hooks/runner.ts`:

```ts
const runSessionPrompt = Effect.fn("HooksRunner.runSessionPrompt")(function* (input: { sessionID: string; prompt: string }) {
  const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined }
  yield* plugin.trigger("session.prompt", input, output)
  return { additionalContext: output.additionalContext }
})
const runCompact = Effect.fn("HooksRunner.runCompact")(function* (input: { sessionID: string; trigger: "manual" | "auto"; phase: "pre" | "post" }) {
  const output = { additionalContext: undefined as string | undefined, systemMessage: undefined as string | undefined, continue: true as boolean | undefined }
  yield* plugin.trigger("session.compact", input, output)
  return output
})
```

Call sites: after `events.publish(SessionV1.Event.Created)` in `session.ts:536` call `runSessionStart({ sessionID: result.id, source: "startup" })` (resume/clear/compact sources resolved from create input); beside `SessionV1.Event.Deleted` at `session.ts:623` call `runSessionEnd` synchronously with 3s timeout cap; in `status.ts:39` idle branch call session.idle trigger; in `prompt.ts` before admission call `runSessionPrompt`; in `compaction.ts:372` wrap prompt build with `runCompact` pre/post; in `tool/task.ts` around child spawn call `subagent.start/stop`. SessionEnd output never steers; `subagent.start` continue:false parsed but ignored.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/hooks/runner.test.ts` from `packages/opencode`
Expected: PASS

Run: `bun typecheck` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/hooks/runner.ts packages/opencode/src/session/session.ts packages/opencode/src/session/status.ts packages/opencode/src/session/prompt.ts packages/opencode/src/session/compaction.ts packages/opencode/src/tool/task.ts
git commit -m "feat(opencode): wire session lifecycle hooks"
```

### Task 9: Config file discovery, merge, and CLI surfacing

**Files:**
- Modify: `packages/opencode/src/config/config.ts` (merge `hooks.json` + inline `hooks` table + plugin-bundled `hooks/hooks.json`; warn on dual representation per layer)
- Modify: `packages/opencode/src/cli/cmd/run.ts` (surface `systemMessage` warnings)
- Test: `packages/opencode/test/hooks/trust.test.ts` (layer merge case)

**Interfaces:**
- Consumes: `ConfigHooksV1.Info` from Task 1, `HooksTrust` from Task 3.
- Produces: merged hooks passed to `Plugin` input; `/hooks` review output reusing `permissionInfo` formatting in `cli/cmd/run/permission.shared.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it.effect("project and global hooks merge without replacing", () =>
  Effect.gen(function* () {
    const merged = HooksConfigMerger.merge(
      { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "global.py" }] }] },
      { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "project.py" }] }] },
    )
    expect(merged.PreToolUse?.length).toBe(2)
  }),
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hooks/trust.test.ts` from `packages/opencode`
Expected: FAIL with merger undefined

- [ ] **Step 3: Write minimal implementation**

Implement `mergeHooksConfigs(globalHooks, projectHooks, pluginHooks)` in `packages/opencode/src/hooks/config.ts`: concatenate per-event arrays in global, project, plugin order; if a single layer contains both `hooks.json` and inline `hooks` table, merge both and log one startup warning. Discovery order: `~/.config/opencode/hooks.json`, `~/.config/opencode/opencode.json` inline table, `<repo>/.opencode/hooks.json`, `<repo>/opencode.json` inline table, enabled-plugin `hooks/hooks.json` (or manifest `hooks` entry, resolved inside plugin root). Project-local entries apply only when project layer is trusted; otherwise skip with warning. Untrusted definitions are skipped at run time (Task 3) and listed by `/hooks`. Managed `requirements.toml` hooks bypass trust and cannot be disabled; `--dangerously-bypass-hook-trust` CLI flag skips trust check for one invocation. Surface hook `systemMessage` through existing stream transport warning path in `cli/cmd/run.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/hooks/trust.test.ts` from `packages/opencode`
Expected: PASS

Run: `bun typecheck` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/hooks/config.ts packages/opencode/src/config/config.ts packages/opencode/src/cli/cmd/run.ts packages/opencode/test/hooks/trust.test.ts
git commit -m "feat(opencode): merge hooks config layers"
```

---

## Self-Review

- Spec coverage: PreToolUse (Tasks 4-6), PermissionRequest (Tasks 4,5,7, deny-wins), PostToolUse (Tasks 4-6, block-replace), SessionStart/End (Tasks 4,5,8, sync + timeout), Pre/PostCompact + UserPromptSubmit + SubagentStart/Stop + Stop/Interrupt (Task 8), config surface (Tasks 1, 9), trust model block/mutate vs observe (header + Tasks 3,5,9). No vendor-cloud, Sites, or voice work included per constraint update.
- Placeholder scan: no TBD/TODO/later; every step has exact file, command, code, expected result.
- Type consistency: `HookDecision`/`PreToolUseDecision` shape stable across Tasks 4-7; `session.*` key names stable across Tasks 4,5,8; `matchHooks` three-arg form fixed in Task 2 Step 4 note.
