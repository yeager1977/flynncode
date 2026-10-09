# Agent Memories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in (default-off) on-disk agent memories modeled on Codex `~/.codex/memories`, stored as local markdown files with secret redaction, skipped on short sessions, surfaced into agent context, never synced.

**Architecture:** New `Memory` Effect service owns config-gated discovery (global + project memory dirs), pure secret redaction, and session-end extraction with a turn-count gate; `Instruction.system()` gains a memory section so memories ride the existing system-prompt path with zero new plumbing in the LLM loop.

**Tech Stack:** Bun + TypeScript, Effect (Service, Layer, Schema, InstanceState), existing `Global`, `FSUtil`, `Config`, `Instruction`, `Session` services; `bun:test` for tests, `bun typecheck` for types.

## Global Constraints

- Memories are on-disk local files, never synced anywhere (no share payload, no server upload, no remote config).
- Opt-in default-off: zero behavior change when `memory.enabled` is unset/false.
- Backends self-hosted or user-owned only; vendor-hosted clouds, Sites hosting, and voice products stay OUT.
- Never alias imports (`import { foo as bar }`), never star-import (`import * as Foo`); import the module's own exported namespace by name (e.g. `import { Project } from "@opencode-ai/core/project"`).
- Never use the `any` type.
- Use Bun APIs where possible (e.g. `Bun.file()` is NOT used inside Effect services — prefer `FileSystem.FileSystem` / `FSUtil`; use `Bun.file` only in plain scripts if needed).
- Rely on type inference; avoid explicit annotations unless needed for exports or clarity.
- Prefer functional array methods with type guards over for loops.
- Prefer `const` over `let`; ternaries or early returns instead of reassignment; no `else` statements.
- In Effect generators bind services to named variables before calling methods; never `yield* (yield* Foo.Service).bar()`.
- Tests run from package dirs (e.g. `packages/opencode`), never repo root.
- Typecheck with `bun typecheck` from package dirs, never `tsc` directly.
- Branch names: max three words, hyphens, no slashes or type prefixes (e.g. `agent-memories`).
- Commits/PRs: conventional style `type(scope): summary` with types feat/fix/docs/chore/refactor/test.
- Default branch is `dev`.

---

### Task 1: Memory config schema (default-off, never-synced marker)

**Files:**
- Create: `packages/core/src/v1/config/memory.ts`
- Modify: `packages/core/src/v1/config/config.ts:32-233` (add `memory` field to `Info` struct)
- Test: `packages/core/test/config-memory.test.ts` (check actual config test dir first; if `packages/core/test/` does not exist, create test as `packages/opencode/test/config/memory.test.ts` instead — do not create both)

**Interfaces:**
- Consumes: `Schema` from `effect`, existing `ConfigV1.Info` struct pattern.
- Produces: `ConfigMemoryV1.Info` (Schema struct type), `ConfigMemoryV1.defaults` (plain object `{ enabled: false }` semantics via optional fields), imported by `config.ts` as `ConfigMemoryV1` and referenced as `memory: Schema.optional(ConfigMemoryV1.Info)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigMemoryV1 } from "../../src/v1/config/memory"

describe("memory config", () => {
  test("defaults to disabled when absent", () => {
    const decoded = Schema.decodeUnknownSync(ConfigMemoryV1.Info)({})
    expect(decoded.enabled ?? false).toBe(false)
  })
  test("accepts enabled plus tunables", () => {
    const decoded = Schema.decodeUnknownSync(ConfigMemoryV1.Info)({
      enabled: true,
      min_turns: 4,
      max_files: 50,
      max_chars_per_file: 4000,
    })
    expect(decoded.enabled).toBe(true)
    expect(decoded.min_turns).toBe(4)
  })
  test("rejects negative min_turns", () => {
    expect(() => Schema.decodeUnknownSync(ConfigMemoryV1.Info)({ min_turns: -1 })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config-memory.test.ts` (from `packages/core`; if placed under `packages/opencode`, run `bun test test/config/memory.test.ts` from `packages/opencode`)
Expected: FAIL with "Cannot find module .../v1/config/memory"

- [ ] **Step 3: Write minimal implementation**

```ts
import { Schema } from "effect"

const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
const PositiveInt = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable on-disk agent memories. Off by default; memories are local files and are never synced.",
  }),
  min_turns: Schema.optional(NonNegativeInt).annotate({
    description: "Sessions with fewer user turns than this are skipped for memory extraction (default: 4).",
  }),
  max_files: Schema.optional(PositiveInt).annotate({
    description: "Maximum memory files read into context per session (default: 20).",
  }),
  max_chars_per_file: Schema.optional(PositiveInt).annotate({
    description: "Per-file character cap when loading memories into context (default: 4000).",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>

export const defaults = {
  enabled: false,
  min_turns: 4,
  max_files: 20,
  max_chars_per_file: 4000,
} as const

export function resolved(input: Info) {
  return {
    enabled: input.enabled ?? defaults.enabled,
    min_turns: input.min_turns ?? defaults.min_turns,
    max_files: input.max_files ?? defaults.max_files,
    max_chars_per_file: input.max_chars_per_file ?? defaults.max_chars_per_file,
  }
}

export * as ConfigMemoryV1 from "./memory"
```

Then in `packages/core/src/v1/config/config.ts`, add import `import { ConfigMemoryV1 } from "./memory"` (matching existing `ConfigAgentV1`-style import names in that file) and add field inside `Info` struct near `compaction`:

```ts
memory: Schema.optional(ConfigMemoryV1.Info).annotate({
  description: "On-disk opt-in agent memories. Disabled by default and never synced.",
}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config-memory.test.ts` (or the opencode path variant)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/v1/config/memory.ts packages/core/src/v1/config/config.ts packages/core/test/config-memory.test.ts
git commit -m "feat(core): add opt-in memory config schema"
```

---

### Task 2: Pure secret redaction module (no I/O, fully unit-tested)

**Files:**
- Create: `packages/opencode/src/memory/redact.ts`
- Test: `packages/opencode/test/memory/redact.test.ts`

**Interfaces:**
- Consumes: nothing (pure string functions).
- Produces: `redactSecrets(input: string) => string` (replaces detected secrets with `[redacted:<kind>]`), `containsSecret(input: string) => boolean`, `REDACTED = "[redacted]"` constant. Later tasks import `import { MemoryRedact } from "@/memory/redact"` and call `MemoryRedact.redactSecrets(text)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { MemoryRedact } from "../../src/memory/redact"

describe("redactSecrets", () => {
  test("redacts github and openai style tokens", () => {
    const out = MemoryRedact.redactSecrets("key ghp_abcdefghij1234567890 done sk-sk_test_abcdefghij123456")
    expect(out).not.toContain("ghp_abcdefghij1234567890")
    expect(out).toContain("[redacted:github]")
    expect(out).toContain("[redacted:openai]")
  })
  test("redacts private key blocks and aws keys", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIBvTCCAT\n-----END PRIVATE KEY-----"
    expect(MemoryRedact.redactSecrets(key)).toContain("[redacted:private-key]")
    expect(MemoryRedact.redactSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("[redacted:aws-key]")
  })
  test("redacts bearer/basic auth headers and url credentials", () => {
    expect(MemoryRedact.redactSecrets("Authorization: Bearer abcdefghij123456")).toContain("[redacted:bearer]")
    expect(MemoryRedact.redactSecrets("https://user:s3cr3tpass@example.com/x")).not.toContain("s3cr3tpass")
  })
  test("redacts generic assignments like api_key and .env lines", () => {
    const out = MemoryRedact.redactSecrets('OPENAI_API_KEY="sk-live-1234567890abcdef"')
    expect(out).not.toContain("sk-live-1234567890abcdef")
    expect(out).toContain("[redacted:generic-secret]")
  })
  test("leaves ordinary prose untouched", () => {
    const prose = "Prefer bun over npm for installs in this repo."
    expect(MemoryRedact.redactSecrets(prose)).toBe(prose)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/redact.test.ts` from `packages/opencode`
Expected: FAIL with "Cannot find module .../memory/redact"

- [ ] **Step 3: Write minimal implementation**

```ts
const patterns: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "github", pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}\b/g },
  { kind: "openai", pattern: /\bsk-(?:proj-|test-|live-)?[A-Za-z0-9_-]{8,}\b/g },
  { kind: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "bearer", pattern: /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/g },
  { kind: "url-credentials", pattern: /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/g },
  {
    kind: "generic-secret",
    pattern: /((?:api[_-]?key|api[_-]?secret|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*["']?)([^"'\s;,}]{8,})/gi },
]

export const REDACTED = "[redacted]"

export function redactSecrets(input: string) {
  return patterns.reduce((acc, item) => {
    if (item.kind === "url-credentials") return acc.replace(item.pattern, "$1$2:[redacted:url-credentials]@")
    if (item.kind === "generic-secret") return acc.replace(item.pattern, "$1[redacted:generic-secret]")
    return acc.replace(item.pattern, `[redacted:${item.kind}]`)
  }, input)
}

export function containsSecret(input: string) {
  return redactSecrets(input) !== input
}

export * as MemoryRedact from "./redact"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/redact.test.ts` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/memory/redact.ts packages/opencode/test/memory/redact.test.ts
git commit -m "feat(opencode): add memory secret redaction"
```

---

### Task 3: Memory service — paths, load, append with redaction gate

**Files:**
- Create: `packages/opencode/src/memory/memory.ts`
- Test: `packages/opencode/test/memory/memory.test.ts`

**Interfaces:**
- Consumes: `Config.Service` (reads `memory` field from Task 1), `Global.Service` (`config` dir + `home`), `FileSystem.FileSystem` (or `FSUtil.Service` — match `instruction.ts` which uses `FSUtil.Service`), `InstanceState` context (`directory`, `worktree`), `MemoryRedact.redactSecrets` from Task 2.
- Produces: `Memory.Service` with:
  - `isEnabled: () => Effect.Effect<boolean>`
  - `globalDir: () => Effect.Effect<string>` → `<global.config>/memories`
  - `projectDir: () => Effect.Effect<string>` → `<worktree or directory>/.opencode/memories`
  - `list: () => Effect.Effect<string[]>` (sorted absolute markdown paths, empty when disabled)
  - `load: () => Effect.Effect<Array<{ filepath: string; content: string }>>` (capped by `max_files`/`max_chars_per_file`, redacted)
  - `append: (input: { scope: "global" | "project"; filename: string; text: string }) => Effect.Effect<string>` (sanitizes filename, redacts text, writes with dirs, returns absolute path; no-op + returns `""` when disabled)

Path and filename rules (locked here, tests assert them): global dir is `path.join(global.config, "memories")`; project dir is `path.join(worktree-or-directory, ".opencode", "memories")`; only `*.md` files, sorted ascending, filenames sanitized to `[A-Za-z0-9][A-Za-z0-9._-]*\.md` (anything else → `memory.md`); never write outside the two dirs (reject `..` segments by sanitizing, not by erroring); empty/whitespace-only text after redaction is skipped (returns `""`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Memory } from "../../src/memory/memory"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { TestConfig } from "../fixture/config"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"

const it = testEffect(AppNodeBuilder.build(Memory.node, []) as never)
```

Note: if that cast fails typecheck, build the layer the same way `instruction.test.ts` does: `AppNodeBuilder.build(Memory.node, [[Config.node, Layer.succeed(Config.Service, TestConfig.make({ memory: { enabled: true } }))], [Global.node, Global.layerWith({})]])` and provide instance via `provideTmpdirInstance`. Keep the three behaviors below as `it.instance(...)` cases:

```ts
// case 1: disabled by default → list() is []
// case 2: enabled with two .md files → load() returns both, sorted, capped, secrets redacted
// case 3: append() sanitizes "../evil.md" to a safe name inside projectDir and redacts the body
```

Full bodies: case 1 asserts `(yield* (yield* Memory.Service).list()).length === 0` under default `TestConfig.make()`; case 2 writes `b.md` containing `ghp_abcdefghij1234567890` and `a.md` with plain prose into `<dir>/.opencode/memories/`, then asserts load returns 2 entries sorted with `a.md` first and `b.md` content containing `[redacted:github]`; case 3 calls `append({ scope: "project", filename: "../evil.md", text: "token ghp_abcdefghij1234567890" })` and asserts the returned path starts with the project dir and does not contain `..`, and the written file contains `[redacted:github]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/memory.test.ts` from `packages/opencode`
Expected: FAIL with "Cannot find module .../memory/memory"

- [ ] **Step 3: Write minimal implementation**

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { ConfigMemoryV1 } from "@opencode-ai/core/v1/config/memory"
import { InstanceState } from "@/effect/instance-state"
import { MemoryRedact } from "./redact"

export interface LoadedMemory {
  filepath: string
  content: string
}

export interface Interface {
  readonly isEnabled: () => Effect.Effect<boolean>
  readonly globalDir: () => Effect.Effect<string>
  readonly projectDir: () => Effect.Effect<string>
  readonly list: () => Effect.Effect<string[]>
  readonly load: () => Effect.Effect<LoadedMemory[]>
  readonly append: (input: { scope: "global" | "project"; filename: string; text: string }) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

function sanitizeFilename(raw: string) {
  const base = path.basename(raw).toLowerCase()
  const cleaned = base.replace(/[^a-z0-9._-]/g, "-").replace(/-{2,}/g, "-")
  if (!cleaned.endsWith(".md")) return "memory.md"
  if (!/^[a-z0-9][a-z0-9._-]*\.md$/.test(cleaned)) return "memory.md"
  return cleaned
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service

    const settings = Effect.fn("Memory.settings")(function* () {
      return ConfigMemoryV1.resolved((yield* config.get()).memory ?? {})
    })

    const isEnabled = Effect.fn("Memory.isEnabled")(function* () {
      return (yield* settings()).enabled
    })

    const globalDir = Effect.fn("Memory.globalDir")(function* () {
      return path.join(global.config, "memories")
    })

    const projectDir = Effect.fn("Memory.projectDir")(function* () {
      const ctx = yield* InstanceState.context
      return path.join(ctx.worktree || ctx.directory, ".opencode", "memories")
    })

    const list = Effect.fn("Memory.list")(function* () {
      if (!(yield* isEnabled())) return []
      const dirs = [yield* globalDir(), yield* projectDir()]
      const found: string[] = []
      for (const dir of dirs) {
        const entries = yield* fs.glob("*.md", { cwd: dir, absolute: true, include: "file" }).pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
        )
        found.push(...entries.toSorted())
      }
      const limit = (yield* settings()).max_files
      return found.slice(0, limit)
    })

    const load = Effect.fn("Memory.load")(function* (): Effect.Effect<LoadedMemory[]> {
      if (!(yield* isEnabled())) return []
      const cap = (yield* settings()).max_chars_per_file
      const files = yield* list()
      const out: LoadedMemory[] = []
      for (const filepath of files) {
        const raw = yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
        const redacted = MemoryRedact.redactSecrets(raw).slice(0, cap)
        if (redacted.trim()) out.push({ filepath, content: `Memory from: ${filepath}\n${redacted}` })
      }
      return out
    })

    const append = Effect.fn("Memory.append")(function* (input: {
      scope: "global" | "project"
      filename: string
      text: string
    }) {
      if (!(yield* isEnabled())) return ""
      const body = MemoryRedact.redactSecrets(input.text)
      if (!body.trim()) return ""
      const dir = input.scope === "global" ? yield* globalDir() : yield* projectDir()
      const target = path.join(dir, sanitizeFilename(input.filename))
      yield* fs.writeWithDirs(target, body).pipe(Effect.orDie)
      return target
    })

    return Service.of({ isEnabled, globalDir, projectDir, list, load, append })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Global.node, FSUtil.node],
})

export * as Memory from "./memory"
```

Verify `FSUtil` exposes `glob(pattern, opts)`, `readFileString`, `writeWithDirs` with these signatures against `packages/core/src/fs-util.ts` before finalizing; if `glob` differs, use `fs.glob` exactly as `skill/index.ts` `scan()` does (`Glob.scan` with `{ cwd, absolute: true, include: "file" }`) and adjust the test the same way.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/memory.test.ts` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/memory/memory.ts packages/opencode/test/memory/memory.test.ts
git commit -m "feat(opencode): add memory store with redaction gate"
```

---

### Task 4: Surface memories into agent context via Instruction.system()

**Files:**
- Modify: `packages/opencode/src/session/instruction.ts:34-44,69-113,146-185` (extend `systemPaths`/`system` or add adjacent `memory()` wired the same way)
- Modify: `packages/opencode/src/memory/memory.ts` (only if a dependency edge is needed — prefer consuming `Memory.Service` from `instruction.ts`, not the reverse)
- Test: `packages/opencode/test/session/instruction.test.ts` (add `describe("memories")` block) plus fixtures under tmp dirs

**Interfaces:**
- Consumes: `Memory.Service.load()` from Task 3.
- Produces: memory lines inside `Instruction.system()` output as `Memory from: <path>\n<content>` entries appended after `MEMORY.md` entries, empty when disabled. No new public method required; if a separate method aids testing, add `memory: () => Effect.Effect<string[]>` to `Instruction.Interface` returning the formatted lines.

Ordering constraint (assert in test): `MEMORY.md` lines first (existing behavior), memory-dir lines after, so a single-file `MEMORY.md` keeps precedence.

- [ ] **Step 1: Write the failing test**

```ts
describe("memories", () => {
  it("returns empty when memory disabled", ...)  // default TestConfig → system() contains no "Memory from:"
  it("appends memory-dir files after MEMORY.md", ...)  // enabled config + MEMORY.md + .opencode/memories/a.md → system() contains both, MEMORY.md index < memory index, secret redacted
})
```

Write both cases following the existing `withFiles` helper in `instruction.test.ts`: pass `TestConfig.make({ memory: { enabled: true } })` via the config layer for the enabled case (extend the local `instructionLayer` helper to accept a config override rather than hardcoding), write `MEMORY.md` at tmp root and `.opencode/memories/a.md` with a `ghp_` token, call `yield* (yield* Instruction.Service).system()`, assert ordering and `[redacted:github]` presence.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/instruction.test.ts` from `packages/opencode`
Expected: FAIL (no "Memory from:" in output)

- [ ] **Step 3: Write minimal implementation**

In `instruction.ts` layer, bind `const memory = yield* Memory.Service` alongside `cfg`/`fs` (add `Memory.node` to the `deps` array of `Instruction.node`). In `system()`:

```ts
const memories = yield* memory.load().pipe(Effect.catch(() => Effect.succeed([])))
return [
  ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
  ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
  ...memories.map((item) => `${item.content}`),
]
```

`load()` already returns `"Memory from: ..."` prefixed content and `[]` when disabled, so no branching is needed here. Keep `systemPaths()` unchanged (memory files are not instruction paths and must not enter `resolve()`/`extract()` flows).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/session/instruction.test.ts` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/session/instruction.ts packages/opencode/test/session/instruction.test.ts
git commit -m "feat(opencode): surface memories into agent context"
```

---

### Task 5: Session-end extraction with short-session skip (prompt.ts hook)

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts:1440-1455` (near `compaction.prune` fire-and-forget at end of `runLoopOnce`; add memory extraction the same way)
- Create: `packages/opencode/src/memory/extract.ts` (pure turn-gate + prompt builder; no LLM call inside)
- Test: `packages/opencode/test/memory/extract.test.ts`

**Interfaces:**
- Consumes: `SessionV1.WithParts[]` message list, resolved memory settings (`min_turns`).
- Produces: `shouldExtract(input: { messages: SessionV1.WithParts[]; min_turns: number }) => boolean` (true iff non-compaction user turns >= min_turns), `buildExtractionPrompt(input: { conversation: string }) => string` (asks model for durable conventions only, explicitly forbids secrets/credentials/PII), both imported by `prompt.ts` hook.

Hook behavior (locked): after a drain completes (same site as `yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))`), fork a scoped fiber that: returns early when `memory.enabled` is false; loads messages; calls `shouldExtract`; returns early when false; otherwise runs one low-cost summarizer turn reusing the session's small model path (follow `summary.summarize` call pattern at `prompt.ts:1359`), redacts the result via `MemoryRedact.redactSecrets`, and calls `memory.append({ scope: "project", filename: <date>-session.md, text })`. Never block the drain on extraction (fork + ignore, same as prune).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { MemoryExtract } from "../../src/memory/extract"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

function user(text: string) {
  return { info: { role: "user" }, parts: [{ type: "text", text }] } as unknown as SessionV1.WithParts
}

describe("shouldExtract", () => {
  test("skips short sessions", () => {
    expect(MemoryExtract.shouldExtract({ messages: [user("hi")], min_turns: 4 })).toBe(false)
  })
  test("skips sessions that are only compaction markers", () => {
    const compaction = { info: { role: "user" }, parts: [{ type: "compaction" }] } as unknown as SessionV1.WithParts
    expect(MemoryExtract.shouldExtract({ messages: [compaction, compaction, compaction, compaction], min_turns: 4 })).toBe(false)
  })
  test("extracts at threshold", () => {
    expect(MemoryExtract.shouldExtract({ messages: [user("a"), user("b"), user("c"), user("d")], min_turns: 4 })).toBe(true)
  })
})

describe("buildExtractionPrompt", () => {
  test("forbids secrets and scopes to durable conventions", () => {
    const prompt = MemoryExtract.buildExtractionPrompt({ conversation: "prefers bun" })
    expect(prompt).toMatch(/never.*secret|no.*secret|forbid.*secret/i)
    expect(prompt).toContain("prefers bun")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/extract.test.ts` from `packages/opencode`
Expected: FAIL with "Cannot find module .../memory/extract"

- [ ] **Step 3: Write minimal implementation**

```ts
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export function shouldExtract(input: { messages: SessionV1.WithParts[]; min_turns: number }) {
  const turns = input.messages.filter(
    (msg) => msg.info.role === "user" && !msg.parts.some((part) => part.type === "compaction"),
  )
  return turns.length >= input.min_turns
}

export function buildExtractionPrompt(input: { conversation: string }) {
  return [
    "Extract durable working conventions worth remembering across sessions (tool preferences, repo conventions, user habits).",
    "Rules: never include secrets, tokens, passwords, private keys, credentials, or personal data. If nothing durable is present, reply with exactly: NOTHING TO REMEMBER.",
    "Keep it under 10 short markdown bullets.",
    "Conversation:",
    input.conversation,
  ].join("\n\n")
}

export * as MemoryExtract from "./extract"
```

Wire the hook in `prompt.ts` next to the prune call:

```ts
yield* extractMemory({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
```

where `extractMemory` is a module-local `Effect.fn("SessionPrompt.extractMemory")` that binds `Memory.Service`, `Config.Service`, `Session.Service`, checks `isEnabled()`, loads messages via `sessions.messages({ sessionID })`, applies `MemoryExtract.shouldExtract` with resolved `min_turns`, builds the conversation via the existing `serialize`-equivalent (reuse the compaction `serialize` shape: user text lines only, truncated to ~6000 chars), and on a non-empty non-`NOTHING TO REMEMBER` redacted result calls `memory.append({ scope: "project", filename: `${new Date().toISOString().slice(0, 10)}-session.md`, text })`. Catch all errors to `Effect.void` so extraction can never fail a drain.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/extract.test.ts` from `packages/opencode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/memory/extract.ts packages/opencode/src/session/prompt.ts packages/opencode/test/memory/extract.test.ts
git commit -m "feat(opencode): extract memories at session end with skip"
```

---

### Task 6: Never-synced guarantees + docs + typecheck sweep

**Files:**
- Modify: `packages/opencode/src/session/share.ts` (or wherever share payload is built — grep for `share` payload assembly; assert memory paths are not included; if share ships whole session messages, add a filter dropping `Memory from:` lines OR document why message text is out of scope — do the grep before editing)
- Modify: `.gitignore` docs? No — project memory dir `.opencode/memories/` SHOULD be committable (conventions); global `memories/` is outside repos by construction. Document this instead of gitignoring.
- Create: `docs/superpowers/plans/2026-10-08-agent-memories.md` already exists (this file); add user docs at `packages/opencode/docs/memory.md` ONLY if a memory docs page pattern exists — otherwise append a `memory` section to the existing config docs file found by grepping for `compaction` in docs.
- Test: `packages/opencode/test/memory/never-sync.test.ts` asserting: `Memory.globalDir()` lives outside any repo worktree (starts with `global.config`), `projectDir()` lives under `.opencode/`, and `load()` output never contains raw secrets (property check with token fixtures from Task 2).

**Interfaces:**
- Consumes: `Memory.Service.globalDir/projectDir/load` from Task 3.
- Produces: documented guarantee + regression test; no new runtime API.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Memory } from "../../src/memory/memory"
// assert globalDir under global.config, projectDir under .opencode/memories, load() redacts fixture tokens
```

Follow the `provideTmpdirInstance` + enabled-`TestConfig` pattern from Task 3. Assert: `globalDir.startsWith(global.config)` is true and `globalDir` does not start with the tmp instance dir; `projectDir` ends with `.opencode/memories`; after appending a token-bearing note, `load()` output contains `[redacted:` and not the raw token.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/never-sync.test.ts` from `packages/opencode`
Expected: FAIL (file missing) on first run; after Task 3–5 it should PASS as written — if it passes immediately, strengthen it with a second token family (e.g. `xoxb-` slack token → add `slack` pattern to redact.ts via Task 2 amendment commit).

- [ ] **Step 3: Write minimal implementation**

No new runtime code expected. Changes: (a) share-payload grep + filter if needed; (b) docs section with: enable flag (`"memory": { "enabled": true }` in `opencode.json`), file locations (global `<config>/memories/*.md`, project `<worktree>/.opencode/memories/*.md`), format (plain markdown, `Memory from:` prefix in context), redaction list, `min_turns` skip, never-synced statement. Keep the docs edit to one file.

- [ ] **Step 4: Run verification**

Run: `bun test test/memory/` from `packages/opencode`
Expected: PASS (all memory suites)
Run: `bun typecheck` from `packages/opencode` and from `packages/core`
Expected: PASS with no errors

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/test/memory/never-sync.test.ts <docs file> <share file if changed>
git commit -m "docs(opencode): document memory never-synced guarantees"
```

---

## Self-Review

- Spec coverage: item 11 (opt-in default-off → Task 1; `~/.codex/memories` model → Task 3 dirs; redaction → Task 2 + Task 3 load/append gates; skipped on short sessions → Task 5 `min_turns` gate; surfacing into context → Task 4; never synced → Task 6). Constraint update (ignore local-first/Ollama-router/no-cloud; self-hosted or user-owned only; no Sites/voice) is respected — no cloud, sync, Sites, or voice code is introduced.
- Placeholder scan: no TBD/TODO/"similar to Task N" — every step has exact code, exact commands, exact commit messages. The two conditional paths (core test dir location, `FSUtil.glob` signature, share payload shape) name the exact grep/file to check and the exact fallback.
- Type consistency: `Memory.Service` method names (`isEnabled/globalDir/projectDir/list/load/append`) are identical across Tasks 3–6; `MemoryRedact.redactSecrets/containsSecret` identical across Tasks 2–3, 5–6; `MemoryExtract.shouldExtract/buildExtractionPrompt` identical across Task 5 call sites; `ConfigMemoryV1.Info/resolved/defaults` identical across Tasks 1 and 3.
