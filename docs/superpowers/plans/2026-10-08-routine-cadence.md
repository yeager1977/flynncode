# Routine Cadence (WS7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Routines support real RRULE recurrence, per-routine persisted run history visible in settings, placement on sidecar vs deepthought via the existing servers UI, and self-hosted poll-based triggers — with no vendor clouds and no inbound public webhooks.

**Architecture:** Extend the existing `packages/opencode/src/plugin/routines/` plugin in place (parse → due → index stays the scheduler owner). RRULE is expanded with the `rrule` npm library against `lastRun`, not passed through as a string. Run history reuses the existing JSONL log plus a bounded `recentRuns` array stored inline on each routine so the settings UI (which already reads `config.routines`) needs no new server API. Placement reuses per-server config: a routine runs on whichever Flynncode server holds it in config. Triggers are poll-only inside the 30s tick.

**Tech Stack:** Bun + TypeScript, `rrule` (new dependency in `packages/opencode`), `chokidar` (already a dependency), `@octokit/rest` (already a dependency), SolidJS settings UI, existing `Flock` serialization, `bun test`, `bun typecheck`.

## Global Constraints

- UI copy via i18n keys in `packages/app/src/i18n/en.ts` only (en only); never hardcode user-visible English in production code.
- No `any` type anywhere.
- No star imports and no aliased imports; import the module's own exported namespace by name where a namespace is needed.
- RRULE must be a real recurrence expansion (compute occurrences from the rule), never a string passthrough.
- Run history persisted per routine (inline `recentRuns`, full log stays in JSONL).
- Backends self-hosted or user-owned only (deepthought host 192.168.4.251 over Tailscale); vendor clouds, Sites hosting, voice stay OUT.
- No inbound public webhooks operated by Flynncode; triggers are poll-based or via user-owned relay only.
- Tests run from package dirs (`packages/opencode`), never repo root; typecheck with `bun typecheck` from package dirs, never `tsc` directly.
- Branch name: `routine-cadence` (max three words, hyphens, no slashes/prefixes). Commits use `type(scope): summary`.
- Follow the repo style guide: dot notation over destructuring, `const` over `let`, early returns over `else`, `Bun.file()`/`Bun.write()` for file I/O.

---

### Task 1: RRULE schedule kind in parse

**Files:**
- Modify: `packages/opencode/src/plugin/routines/parse.ts`
- Test: `packages/opencode/test/plugin/routines/parse.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Routine` gains `rrule?: string`; `parseRoutines` accepts `schedule: { rrule: string }` and rejects it combined with `dailyAt`/`interval`; `readRrule` validates with the `rrule` library.

- [ ] **Step 1: Add the dependency**

Run: `bun add rrule` with `workdir` `packages/opencode`
Expected: `rrule` appears in `packages/opencode/package.json` dependencies.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { parseRoutines } from "../../../src/plugin/routines/parse"

describe("rrule schedule", () => {
  test("parses an RRULE schedule", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" } }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routines[0]).toMatchObject({ id: "a", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" })
  })

  test("rejects an invalid RRULE string", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { rrule: "EVERY=monday" } }],
    })
    expect(result.ok).toBe(false)
  })

  test("rejects rrule combined with dailyAt", () => {
    const result = parseRoutines({
      routines: [{ id: "a", name: "A", prompt: "go", schedule: { dailyAt: "09:00", rrule: "FREQ=DAILY" } }],
    })
    expect(result.ok).toBe(false)
  })
}
```

Append to `packages/opencode/test/plugin/routines/parse.test.ts`.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/plugin/routines/parse.test.ts` with `workdir` `packages/opencode`
Expected: FAIL (unknown schedule shape / missing `rrule` field).

- [ ] **Step 4: Implement**

In `packages/opencode/src/plugin/routines/parse.ts`, add at top (no star import, no alias):

```ts
import { RRule } from "rrule"
```

Extend the type (keep existing fields byte-for-byte):

```ts
export type Routine = {
  id: string
  name: string
  prompt: string
  enabled: boolean
  dailyAt?: string
  interval?: string
  rrule?: string
  lastRun?: string
}
```

In `parseRoutine`, pass `schedule.rrule` through: add `rrule: schedule.rrule` to the returned object. In `readSchedule`, add:

```ts
const rrule = readRrule(row.rrule, index, errors)
const set = [dailyAt, interval, rrule].filter((entry) => entry !== undefined)
if (set.length > 1) {
  errors.push(`routines.${index}.schedule must set only one of dailyAt, interval, rrule`)
  return
}
return { dailyAt, interval, rrule }
```

Add below `readInterval`:

```ts
function readRrule(rrule: unknown, index: number, errors: string[]) {
  if (rrule === undefined) return undefined
  if (typeof rrule !== "string" || rrule.trim() === "") {
    errors.push(`routines.${index}.schedule.rrule must be an RRULE string like FREQ=WEEKLY;BYDAY=MO`)
    return undefined
  }
  try {
    RRule.fromString(rrule)
  } catch {
    errors.push(`routines.${index}.schedule.rrule must be a valid RRULE string`)
    return undefined
  }
  return rrule
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/plugin/routines/parse.test.ts` with `workdir` `packages/opencode`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bun typecheck` with `workdir` `packages/opencode`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/plugin/routines/parse.ts packages/opencode/test/plugin/routines/parse.test.ts packages/opencode/package.json packages/opencode/bun.lock
git commit -m "feat(routines): accept RRULE schedule kind"
```

---

### Task 2: RRULE due expansion

**Files:**
- Modify: `packages/opencode/src/plugin/routines/due.ts`
- Test: `packages/opencode/test/plugin/routines/due.test.ts`

**Interfaces:**
- Consumes: `Routine.rrule` from Task 1.
- Produces: `isDue` returns true for RRULE routines when an occurrence falls in `(lastRun, now]`; `nextOccurrence(routine, now)` exported for UI display.

- [ ] **Step 1: Write the failing test**

```ts
describe("rrule", () => {
  test("fires on a matching weekday", () => {
    const weekly = routine({ dailyAt: undefined, rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" })
    // 2026-09-21 is a Monday
    expect(isDue(weekly, new Date(2026, 8, 21, 9, 0))).toBe(true)
    expect(isDue(weekly, new Date(2026, 8, 22, 9, 0))).toBe(false)
  })

  test("does not refire after running", () => {
    const ran = routine({
      dailyAt: undefined,
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
      lastRun: new Date(2026, 8, 21, 9, 0, 5).toISOString(),
    })
    expect(isDue(ran, new Date(2026, 8, 21, 9, 0, 40))).toBe(false)
  })

  test("invalid rrule never fires", () => {
    const broken = routine({ dailyAt: undefined, rrule: "EVERY=monday" })
    expect(isDue(broken, new Date(2026, 8, 21, 9, 0))).toBe(false)
  })
})
```

Append to `packages/opencode/test/plugin/routines/due.test.ts`. Note the local `routine()` helper defaults `dailyAt: "09:00"`, so RRULE tests pass `dailyAt: undefined` explicitly.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/plugin/routines/due.test.ts` with `workdir` `packages/opencode`
Expected: FAIL (`rrule` ignored, weekly routine never due).

- [ ] **Step 3: Implement real expansion**

In `packages/opencode/src/plugin/routines/due.ts`, replace the import line with:

```ts
import { RRule } from "rrule"
import { intervalMs, type Routine } from "./parse"
```

In `isDue`, add as the first schedule branch (after the `enabled` check, before `interval`):

```ts
if (routine.rrule) return isRruleDue(routine, now)
```

Add below `isDue`:

```ts
function rruleOptions(routine: Routine) {
  try {
    return RRule.fromString(routine.rrule ?? "")
  } catch {
    return undefined
  }
}

function isRruleDue(routine: Routine, now: Date) {
  const rule = rruleOptions(routine)
  if (!rule) return false
  const last = routine.lastRun ? new Date(routine.lastRun) : undefined
  if (last && Number.isNaN(last.getTime())) return true
  // O(1): the next occurrence strictly after lastRun (inclusive) is due when it is not in the future.
  const after = last ?? new Date(2000, 0, 1)
  const next = rule.after(after, true)
  if (!next) return false
  return next.getTime() <= now.getTime()
}

export function nextOccurrence(routine: Routine, now: Date) {
  const rule = rruleOptions(routine)
  if (!rule) return undefined
  const next = rule.after(now, false)
  return next ?? undefined
}
```

Note: `RRule.fromString` parses in local time, matching the existing `dailyAt` local-day behavior. `rule.after` with a far-past anchor is a single occurrence computation, not a full expansion — no unbounded iteration.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/plugin/routines/due.test.ts` with `workdir` `packages/opencode`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun typecheck` with `workdir` `packages/opencode`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/plugin/routines/due.ts packages/opencode/test/plugin/routines/due.test.ts
git commit -m "feat(routines): expand RRULE occurrences for due checks"
```

---

### Task 3: Per-routine run history persisted inline + JSONL

**Files:**
- Modify: `packages/opencode/src/plugin/routines/parse.ts`, `packages/opencode/src/plugin/routines/index.ts`
- Test: `packages/opencode/test/plugin/routines/parse.test.ts` (extend), new `packages/opencode/test/plugin/routines/runs.test.ts`

**Interfaces:**
- Consumes: `RoutineRun` and `recordRoutineRun` already in `index.ts`.
- Produces: `Routine.recentRuns?: RoutineRun[]` (max 10, newest last) round-tripped through `stored()`/`markRan`; `recordRoutineRun` unchanged as the full 200-entry log.

- [ ] **Step 1: Write the failing test**

Create `packages/opencode/test/plugin/routines/runs.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { parseRunRecords, type RoutineRun } from "../../../src/plugin/routines/index"

function run(patch: Partial<RoutineRun> = {}): RoutineRun {
  return {
    routineId: "triage",
    agent: "build",
    startedAt: new Date(2026, 8, 22, 9, 0).toISOString(),
    endedAt: new Date(2026, 8, 22, 9, 1).toISOString(),
    state: "ok",
    ...patch,
  }
}

describe("parseRunRecords", () => {
  test("skips corrupt lines and keeps the tail", () => {
    const text = [JSON.stringify(run()), "not-json", "", JSON.stringify(run({ state: "error" }))].join("\n")
    const records = parseRunRecords(text)
    expect(records.length).toBe(2)
    expect(records[1].state).toBe("error")
  })

  test("caps at the newest 200", () => {
    const text = Array.from({ length: 250 }, (_, n) =>
      JSON.stringify(run({ startedAt: new Date(2026, 8, 22, 9, 0, n).toISOString() })),
    ).join("\n")
    expect(parseRunRecords(text).length).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it passes already (characterization)**

Run: `bun test test/plugin/routines/runs.test.ts` with `workdir` `packages/opencode`
Expected: PASS (locks in existing JSONL behavior before extending it).

- [ ] **Step 3: Extend parse with recentRuns**

In `packages/opencode/src/plugin/routines/parse.ts`, add to `Routine`:

```ts
recentRuns?: RoutineRunSummary[]
```

where (defined in `parse.ts` to avoid a Core/Protocol dependency cycle — keep the dependency direction Schema → Core → Server intact):

```ts
export type RoutineRunSummary = {
  sessionID?: string
  startedAt: string
  endedAt: string
  state: "ok" | "error"
  error?: string
}
```

In `parseRoutine`, read `row.recentRuns`: keep entries that are objects with string `startedAt`/`endedAt` and `state` of `"ok"` or `"error"`, slice to the last 10. Return `recentRuns` only when non-empty (else `undefined` to keep stored configs small).

- [ ] **Step 4: Persist recentRuns on every run**

In `packages/opencode/src/plugin/routines/index.ts`:
- `stored()` must include `recentRuns: routine.recentRuns` (round-trip; `recentRuns: undefined` serializes away under JSON).
- In the `due.map` tick, after `recordRoutineRun` succeeds, build the summary from the same timestamps/state and call `markRan` with both the id and the summary. Change `markRanEffect`'s `ids: string[]` param to `runs: { id: string; summary: RoutineRunSummary }[]` and set `{ ...current, lastRun: now.toISOString(), recentRuns: [...(current.recentRuns ?? []), summary].slice(-10) }`. Update the single caller in the tick.
- Error path: record the error summary inline too (same as ok path), so failed runs appear in history.

Import the summary type from `./parse` with a type-only import: `import { parseRoutines, type Routine, type RoutineRunSummary } from "./parse"`.

- [ ] **Step 5: Run all routine tests**

Run: `bun test test/plugin/routines/` with `workdir` `packages/opencode`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bun typecheck` with `workdir` `packages/opencode`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/plugin/routines/ packages/opencode/test/plugin/routines/
git commit -m "feat(routines): persist per-routine recent run history"
```

---

### Task 4: Settings UI — RRULE field, run history, placement picker

**Files:**
- Modify: `packages/app/src/components/settings-v2/routines-edit.ts`, `packages/app/src/components/settings-v2/routines.tsx`, `packages/app/src/i18n/en.ts`

**Interfaces:**
- Consumes: `StoredRoutine` gains `rrule?: string` and `recentRuns` summaries; `routinesToConfig` round-trips both.
- Produces: no new exports; UI only.

- [ ] **Step 1: Extend routines-edit**

In `packages/app/src/components/settings-v2/routines-edit.ts`:
- `StoredRoutine` gains `rrule?: string` and `recentRuns?: { sessionID?: string; startedAt: string; endedAt: string; state: "ok" | "error"; error?: string }[]`.
- `routinesFromConfig` reads `schedule.rrule` (string starting with `FREQ=`, else `undefined`) and `recentRuns` (validated array, max 10, else `undefined`).
- `routinesToConfig` writes `schedule` as `{ dailyAt }` / `{ interval }` / `{ rrule }` (first defined wins in that priority) and passes `recentRuns` through.
- `addRoutine` input gains `rrule?: string`; when `rrule` is set, `dailyAt` and `interval` are dropped.

- [ ] **Step 2: Extend the settings form**

In `packages/app/src/components/settings-v2/routines.tsx`:
- Draft store gains `rrule: ""`.
- `create()` validates: if `draft.rrule` is non-empty it must match `/^FREQ=[A-Z]+;/` (else `setDraft("error", language.t("settings.routines.rruleInvalid"))` and return); when `rrule` is set, `dailyAt`/`interval` are ignored.
- Add one input bound to `draft.rrule` with `aria-label` and `placeholder` from `language.t("settings.routines.rrule")`.
- Each routine row renders its cadence label as `routine.rrule ?? routine.dailyAt ?? routine.interval ?? language.t("settings.routines.manual")` and, when `routine.recentRuns` is non-empty, a history list showing `startedAt` plus `language.t("settings.routines.runOk")` / `language.t("settings.routines.runError")` per entry.

- [ ] **Step 3: Placement picker (sidecar vs deepthought, no new vocabulary)**

Placement rule (also written into `settings.routines.targetDescription`): a routine runs on the Flynncode server whose config holds it. The desktop already attaches to multiple servers (sidecar + deepthought over Tailscale) via Settings servers.
- In `routines.tsx`, reuse the existing `settings-server-picker.tsx` component above the form so the user picks which attached server the new routine is saved to; `save()` calls `updateConfig` on the picked server's sync context. If the picker component requires props the routines context cannot supply, render a read-only line with `language.t("settings.routines.targetDescription")` stating the active server runs the routine instead — do not invent a new picker.

- [ ] **Step 4: Add en i18n keys**

In `packages/app/src/i18n/en.ts` after `"settings.routines.intervalInvalid"`:

```ts
"settings.routines.rrule": "Recurrence (RRULE, e.g. FREQ=WEEKLY;BYDAY=MO)",
"settings.routines.rruleInvalid": "Use an RRULE like FREQ=WEEKLY;BYDAY=MO",
"settings.routines.runOk": "Ran fine",
"settings.routines.runError": "Failed",
"settings.routines.history": "Recent runs",
"settings.routines.historyEmpty": "No runs yet",
"settings.routines.targetDescription": "Routines run on the server that stores them. The app or host must be awake.",
```

- [ ] **Step 5: Verify UI**

Run: open `http://localhost:4444` with backend `bun run ./src/index.ts serve --port 4096` (per `packages/app/AGENTS.md`), open Settings → Routines, add an RRULE routine, confirm the row shows the RRULE string and history section.
Expected: manual verification passes; no console errors.

- [ ] **Step 6: Typecheck app**

Run: `bun typecheck` with `workdir` `packages/app`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/components/settings-v2/routines-edit.ts packages/app/src/components/settings-v2/routines.tsx packages/app/src/i18n/en.ts
git commit -m "feat(app): RRULE field, run history, and placement picker for routines"
```

---

### Task 5: Poll-based file trigger (no webhooks)

**Files:**
- Create: `packages/opencode/src/plugin/routines/trigger.ts`
- Modify: `packages/opencode/src/plugin/routines/parse.ts`, `packages/opencode/src/plugin/routines/due.ts`, `packages/opencode/src/plugin/routines/index.ts`
- Test: `packages/opencode/test/plugin/routines/trigger.test.ts`

**Interfaces:**
- Consumes: `Routine` gains `trigger?: { files?: string[] }`; scheduler passes the plugin `directory`.
- Produces: `triggerDue(routine, directory, now)` returning true when a glob match has mtime newer than `lastRun`; `parse.ts` validates `trigger.files` as a non-empty string array of relative globs.

- [ ] **Step 1: Write the failing test**

Create `packages/opencode/test/plugin/routines/trigger.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { triggerDue } from "../../../src/plugin/routines/trigger"

describe("triggerDue", () => {
  test("fires when a matched file changed since lastRun", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "notes.md")
    await Bun.write(file, "hello")
    const routine = {
      id: "w",
      name: "W",
      prompt: "go",
      enabled: true,
      lastRun: new Date(Date.now() - 60_000).toISOString(),
      trigger: { files: ["*.md"] },
    }
    expect(await triggerDue(routine, tmp.path)).toBe(true)
  })

  test("is quiet when nothing changed", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "notes.md")
    await Bun.write(file, "hello")
    const old = new Date(Date.now() - 60_000).toISOString()
    await Bun.file(file).stat().then(() => undefined)
    const routine = { id: "w", name: "W", prompt: "go", enabled: true, lastRun: new Date().toISOString(), trigger: { files: ["*.md"] } }
    expect(await triggerDue(routine, tmp.path)).toBe(false)
    expect(old).toBeDefined()
  })

  test("no trigger means not due", async () => {
    await using tmp = await tmpdir()
    expect(await triggerDue({ id: "w", name: "W", prompt: "go", enabled: true }, tmp.path)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/plugin/routines/trigger.test.ts` with `workdir` `packages/opencode`
Expected: FAIL (`trigger.ts` does not exist).

- [ ] **Step 3: Implement poll trigger**

Create `packages/opencode/src/plugin/routines/trigger.ts`:

```ts
import { Glob } from "bun"
import path from "path"
import type { Routine } from "./parse"

export async function triggerDue(routine: Routine, directory: string) {
  const patterns = routine.trigger?.files
  if (!patterns || patterns.length === 0) return false
  const since = routine.lastRun ? new Date(routine.lastRun).getTime() : 0
  for (const pattern of patterns) {
    const glob = new Glob(pattern)
    for await (const entry of glob.scan({ cwd: directory, onlyFiles: true })) {
      const stat = await Bun.file(path.join(directory, entry)).stat().catch(() => undefined)
      if (stat && stat.mtime.getTime() > since) return true
    }
  }
  return false
}
```

`parse.ts`: `Routine` gains `trigger?: { files: string[] }`; `readSchedule`-adjacent `readTrigger` accepts `trigger: { files: string[] }` with 1–10 relative patterns (reject absolute paths and `..` segments); wire into `parseRoutine` and `stored()` in `index.ts`.

`due.ts`: `isDue` stays synchronous for cadence; in `index.ts` tick, after `dueRoutines`, additionally `await triggerDue` per routine with no cadence due and merge the lists (dedupe by id) before `Promise.allSettled`.

- [ ] **Step 4: Run tests**

Run: `bun test test/plugin/routines/` with `workdir` `packages/opencode`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun typecheck` with `workdir` `packages/opencode`
Expected: clean.

```bash
git add packages/opencode/src/plugin/routines/ packages/opencode/test/plugin/routines/trigger.test.ts
git commit -m "feat(routines): poll-based file trigger"
```

---

### Task 6: Poll-based GitHub trigger (REST poll, no webhooks)

**Files:**
- Modify: `packages/opencode/src/plugin/routines/trigger.ts`, `packages/opencode/src/plugin/routines/parse.ts`, `packages/opencode/src/plugin/routines/index.ts`
- Test: `packages/opencode/test/plugin/routines/trigger.test.ts` (extend)

**Interfaces:**
- Consumes: `triggerDue` from Task 5; `Routine.trigger.github?: { owner: string; repo: string; event: "pr" | "issue" }`.
- Produces: GitHub poll that compares the newest `updated_at` against per-routine state stored alongside the JSONL runs file (`routines-trigger-state.json` in `Global.Path.state`, keyed by routine id, under the same `Flock` key family).

- [ ] **Step 1: Write the failing test**

```ts
test("github trigger validates config shape", () => {
  const { parseRoutines } = require("../../../src/plugin/routines/parse") as typeof import("../../../src/plugin/routines/parse")
  const bad = parseRoutines({
    routines: [{ id: "g", name: "G", prompt: "go", trigger: { github: { owner: "o" } } }],
  })
  expect(bad.ok).toBe(false)
})
```

Do not use `require`; use a top-level static import instead:

```ts
import { parseRoutines } from "../../../src/plugin/routines/parse"
```

then:

```ts
test("github trigger requires owner, repo, and event", () => {
  const bad = parseRoutines({
    routines: [{ id: "g", name: "G", prompt: "go", trigger: { github: { owner: "o" } } }],
  })
  expect(bad.ok).toBe(false)
  const good = parseRoutines({
    routines: [{ id: "g", name: "G", prompt: "go", trigger: { github: { owner: "o", repo: "r", event: "pr" } } }],
  })
  expect(good.ok).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/plugin/routines/trigger.test.ts` with `workdir` `packages/opencode`
Expected: FAIL (github trigger shape unknown).

- [ ] **Step 3: Implement**

- `parse.ts`: `TriggerGithub = { owner: string; repo: string; event: "pr" | "issue" }`; validate all three, `event` must be `"pr"` or `"issue"`.
- `trigger.ts`: add `githubDue(routine, token)` using `Octokit` from `@octokit/rest` (already a dependency): list PRs (`pulls.list`, `sort: updated`, `direction: desc`, `per_page: 1`) or issues (`issues.listForRepo`, same sort); compare newest `updated_at` with stored state; update state file under `Flock.effect("routines-trigger-state:...")`. No token → return false (never throw; log via `console.warn` with the `[routines]` prefix).
- `index.ts` tick: read `process.env.GITHUB_TOKEN` once per tick; run `githubDue` only for routines carrying a github trigger, at most once per tick per routine; merge into the due set.
- Poll cost guard: github triggers are evaluated at most every 5 minutes per routine (store `checkedAt` in the state file; skip when newer).

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `bun test test/plugin/routines/` then `bun typecheck`, both with `workdir` `packages/opencode`
Expected: PASS / clean.

```bash
git add packages/opencode/src/plugin/routines/ packages/opencode/test/plugin/routines/trigger.test.ts
git commit -m "feat(routines): poll-based GitHub trigger without webhooks"
```

---

### Task 7: Docs + final verification

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-routines-design.md` — append a dated addendum only, do not rewrite history.

**Interfaces:** none.

- [ ] **Step 1: Append WS7 addendum**

Add a `## 2026-10-08 WS7 addendum: RRULE cadence + run history + self-hosted triggers` section stating: `schedule` now accepts `{ rrule }` (RFC 5545 via the `rrule` package, expanded locally); `recentRuns` (last 10) persisted per routine with the full 200-entry JSONL log retained; placement = the server holding the config (sidecar or deepthought, app/host must be awake); triggers are poll-only (`trigger.files` mtime poll, `trigger.github` REST poll every ≥5min); inbound public webhooks remain out.

- [ ] **Step 2: Full verification**

Run: `bun test test/plugin/routines/` and `bun typecheck` with `workdir` `packages/opencode`; `bun typecheck` with `workdir` `packages/app`.
Expected: all PASS / clean.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-22-routines-design.md
git commit -m "docs(routines): record WS7 cadence addendum"
```

## Self-Review

- Spec coverage: report item 6 (RRULE cadence + run history, sidecar/deepthought target) → Tasks 1–4; skipped self-hosted triggers revived per constraint update → Tasks 5–6 (poll-only, no webhooks). Vendor clouds/Sites/voice untouched.
- No placeholders: every step names exact files, code, commands, expected outcomes, and commit messages.
- Type consistency: `Routine.rrule`, `Routine.trigger`, `Routine.recentRuns`, `RoutineRunSummary`, `nextOccurrence`, `triggerDue`/`githubDue` named identically across tasks.
