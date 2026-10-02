# Session Bulk Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the sidebar and home session lists multi-select sessions, then archive or permanently delete them, and clean up sessions older than a chosen last-updated preset.

**Architecture:** One pure module decides eligibility, age, protection, and selection. One runner archives or deletes frozen root ids one at a time and stops on the first failure. Both lists call those functions. Sidebar Clean up loads the full directory through `listAllSessions`. Home Clean up uses the full home session index, not the trimmed visible window.

**Tech Stack:** SolidJS, existing session update/remove clients, `@opencode-ai/ui` dialog and checkbox, Bun tests in `packages/app`.

## Global Constraints

- Product is Flynncode, not upstream OpenCode.
- Both the sidebar session list and the home session list get Select and Clean up.
- Archive and permanent delete are both available for multi-select and age cleanup.
- Age uses `time.updated`, then `time.created`. A session is older only when that timestamp is strictly before `now - duration`.
- Preset durations are 7, 14, 30, 90, 180, and 365 days. Not calendar months.
- Skip the open route, any session open in a tab, any running session, any session waiting on a permission or question, and any root whose child is protected.
- Select acts only on loaded root rows. Clean up does not.
- A workspace header covers that directory only, not sibling workspaces. Home covers every root session on that server.
- Archive calls `session.update` with `time.archived` on v1 and v2. Do not use the old v1-only early return.
- Delete calls `session.remove` once per root. The server already deletes children.
- Calls run one at a time. A failure stops the rest. Successes stay removed.
- Nothing is sent before confirm. Re-check protection immediately before each call.
- Do not add restore, a home per-row archive button, TUI support, or an end-to-end test.
- Keep the sidebar hover archive. Leave `SHOW_HOME_SESSION_ARCHIVE` false.
- Visible copy uses `language.t` or `language.plural`. Add English keys only. Do not invent translations.
- Do not concatenate grammatical fragments. Show the match line and the skip line separately.
- Run tests from `packages/app`, never the repo root.
- Do not restart an existing app or server.
- Commit only if the user asks.

---

### Task 1: Eligibility and selection

**Files:**
- Create: `packages/app/src/pages/session/session-bulk.ts`
- Test: `packages/app/src/pages/session/session-bulk.test.ts`

**Interfaces:**
- Consumes: `Session` from `@opencode-ai/sdk/v2/client`
- Produces:
  - `BULK_PRESETS`, `BulkPreset`
  - `sessionTimestamp(session: Session): number`
  - `isOlderThan(session: Session, now: number, days: number): boolean`
  - `eligibleRoots(sessions: readonly Session[]): Session[]`
  - `protectedRootIDs(sessions: readonly Session[], input: ProtectionInput): Set<string>`
  - `cleanupCandidates(sessions: readonly Session[], now: number, days: number, blocked: ReadonlySet<string>): { match: Session[]; skipped: Session[] }`
  - `toggleID(selected: readonly string[], id: string, allowed: ReadonlySet<string>): string[]`
  - `selectRange(input: RangeInput): { selected: string[]; anchor: string | undefined }`
  - `selectLoaded(order: readonly string[], allowed: ReadonlySet<string>): string[]`
  - `presetDays(id: BulkPreset): number`

```ts
export const BULK_PRESETS = [
  { id: "1w", days: 7 },
  { id: "2w", days: 14 },
  { id: "1m", days: 30 },
  { id: "3m", days: 90 },
  { id: "6m", days: 180 },
  { id: "1y", days: 365 },
] as const

export type BulkPreset = (typeof BULK_PRESETS)[number]["id"]

export type ProtectionInput = {
  openRouteID?: string
  openTabIDs: ReadonlySet<string>
  working: (id: string) => boolean
  pending: (id: string) => boolean
}

export type RangeInput = {
  order: readonly string[]
  selected: readonly string[]
  anchor: string | undefined
  id: string
  allowed: ReadonlySet<string>
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  BULK_PRESETS,
  cleanupCandidates,
  eligibleRoots,
  isOlderThan,
  protectedRootIDs,
  selectLoaded,
  selectRange,
  toggleID,
} from "./session-bulk"

const DAY = 86_400_000
const now = 10 * DAY

const session = (input: Partial<Session> & Pick<Session, "id">): Session =>
  ({
    id: input.id,
    directory: "/repo",
    title: input.id,
    parentID: input.parentID,
    time: { created: 0, updated: 0, archived: undefined, ...input.time },
    ...input,
  }) as Session

describe("session bulk eligibility", () => {
  test("uses fixed day counts", () => {
    expect(BULK_PRESETS.map((preset) => [preset.id, preset.days])).toEqual([
      ["1w", 7],
      ["2w", 14],
      ["1m", 30],
      ["3m", 90],
      ["6m", 180],
      ["1y", 365],
    ])
  })

  test("keeps a session updated at the exact cutoff", () => {
    const item = session({ id: "exact", time: { created: 0, updated: now - 7 * DAY } })
    expect(isOlderThan(item, now, 7)).toBe(false)
    expect(isOlderThan(session({ id: "old", time: { created: 0, updated: now - 7 * DAY - 1 } }), now, 7)).toBe(true)
  })

  test("falls back to created when updated is missing", () => {
    const item = session({ id: "created", time: { created: now - 14 * DAY - 1, updated: undefined } })
    expect(isOlderThan(item, now, 14)).toBe(true)
  })

  test("drops archived sessions and children from roots", () => {
    const roots = eligibleRoots([
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "gone", time: { created: 0, updated: 0, archived: 1 } }),
    ])
    expect(roots.map((item) => item.id)).toEqual(["root"])
  })

  test("locks open, tabbed, running, pending, and parent of a protected child", () => {
    const sessions = [
      session({ id: "route" }),
      session({ id: "tab" }),
      session({ id: "running" }),
      session({ id: "waiting" }),
      session({ id: "parent" }),
      session({ id: "child", parentID: "parent" }),
      session({ id: "free" }),
    ]
    const blocked = protectedRootIDs(sessions, {
      openRouteID: "route",
      openTabIDs: new Set(["tab"]),
      working: (id) => id === "running" || id === "child",
      pending: (id) => id === "waiting",
    })
    expect([...blocked].sort()).toEqual(["child", "parent", "route", "running", "tab", "waiting"])
  })

  test("cleanup splits old matches from old protected roots", () => {
    const sessions = [
      session({ id: "old", time: { created: 0, updated: 1 } }),
      session({ id: "busy", time: { created: 0, updated: 1 } }),
      session({ id: "fresh", time: { created: 0, updated: now } }),
    ]
    const result = cleanupCandidates(sessions, now, 7, new Set(["busy"]))
    expect(result.match.map((item) => item.id)).toEqual(["old"])
    expect(result.skipped.map((item) => item.id)).toEqual(["busy"])
  })

  test("selection skips ids that are not allowed", () => {
    const allowed = new Set(["a", "c"])
    expect(toggleID(["a"], "b", allowed)).toEqual(["a"])
    expect(toggleID(["a"], "c", allowed)).toEqual(["a", "c"])
    expect(selectLoaded(["a", "b", "c"], allowed)).toEqual(["a", "c"])
    expect(
      selectRange({ order: ["a", "b", "c"], selected: [], anchor: "a", id: "c", allowed }),
    ).toEqual({ selected: ["a", "c"], anchor: "a" })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/session-bulk.test.ts`
Expected: FAIL because `session-bulk` is missing.

- [ ] **Step 3: Write the module**

```ts
import type { Session } from "@opencode-ai/sdk/v2/client"

const DAY = 86_400_000

export const BULK_PRESETS = [
  { id: "1w", days: 7 },
  { id: "2w", days: 14 },
  { id: "1m", days: 30 },
  { id: "3m", days: 90 },
  { id: "6m", days: 180 },
  { id: "1y", days: 365 },
] as const

export type BulkPreset = (typeof BULK_PRESETS)[number]["id"]

export type ProtectionInput = {
  openRouteID?: string
  openTabIDs: ReadonlySet<string>
  working: (id: string) => boolean
  pending: (id: string) => boolean
}

export type RangeInput = {
  order: readonly string[]
  selected: readonly string[]
  anchor: string | undefined
  id: string
  allowed: ReadonlySet<string>
}

export function presetDays(id: BulkPreset) {
  const preset = BULK_PRESETS.find((item) => item.id === id)
  if (!preset) return 7
  return preset.days
}

export function sessionTimestamp(session: Session) {
  return session.time.updated ?? session.time.created
}

export function isOlderThan(session: Session, now: number, days: number) {
  return sessionTimestamp(session) < now - days * DAY
}

export function eligibleRoots(sessions: readonly Session[]) {
  return sessions.filter((session) => !session.parentID && session.time.archived === undefined)
}

export function protectedRootIDs(sessions: readonly Session[], input: ProtectionInput) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const blocked = new Set<string>()
  const blockedSelf = (id: string) =>
    id === input.openRouteID || input.openTabIDs.has(id) || input.working(id) || input.pending(id)

  for (const session of sessions) {
    if (blockedSelf(session.id)) blocked.add(session.id)
  }
  for (const id of blocked) {
    let parentID = byID.get(id)?.parentID
    while (parentID) {
      blocked.add(parentID)
      parentID = byID.get(parentID)?.parentID
    }
  }
  return blocked
}

export function cleanupCandidates(
  sessions: readonly Session[],
  now: number,
  days: number,
  blocked: ReadonlySet<string>,
) {
  const match: Session[] = []
  const skipped: Session[] = []
  for (const session of eligibleRoots(sessions)) {
    if (!isOlderThan(session, now, days)) continue
    if (blocked.has(session.id)) {
      skipped.push(session)
      continue
    }
    match.push(session)
  }
  return { match, skipped }
}

export function toggleID(selected: readonly string[], id: string, allowed: ReadonlySet<string>) {
  if (!allowed.has(id)) return [...selected]
  if (selected.includes(id)) return selected.filter((item) => item !== id)
  return [...selected, id]
}

export function selectRange(input: RangeInput) {
  if (!input.allowed.has(input.id)) return { selected: [...input.selected], anchor: input.anchor }
  if (!input.anchor) return { selected: toggleID([], input.id, input.allowed), anchor: input.id }
  const start = input.order.indexOf(input.anchor)
  const end = input.order.indexOf(input.id)
  if (start === -1 || end === -1) return { selected: toggleID(input.selected, input.id, input.allowed), anchor: input.id }
  const [from, to] = start < end ? [start, end] : [end, start]
  const next = new Set(input.selected)
  for (const id of input.order.slice(from, to + 1)) {
    if (input.allowed.has(id)) next.add(id)
  }
  return { selected: [...next], anchor: input.anchor }
}

export function selectLoaded(order: readonly string[], allowed: ReadonlySet<string>) {
  return order.filter((id) => allowed.has(id))
}
```

`selectRange` with no anchor selects only the clicked id. Shift-click adds the allowed ids in the inclusive range to the existing selection and does not move the anchor.

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/app`: `bun test src/pages/session/session-bulk.test.ts`
Expected: PASS

### Task 2: Runner

**Files:**
- Create: `packages/app/src/pages/session/session-bulk-run.ts`
- Test: `packages/app/src/pages/session/session-bulk-run.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1. The caller passes already chosen ids.
- Produces: `BulkOp`, `BulkRunResult`, `runSessionBulk(input: BulkRunInput): Promise<BulkRunResult>`

```ts
export type BulkOp = "archive" | "delete"

export type BulkRunInput = {
  ids: readonly string[]
  op: BulkOp
  isProtected: (id: string) => boolean
  archive: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export type BulkRunResult = {
  done: string[]
  failed?: string
  pending: string[]
  skipped: string[]
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { runSessionBulk } from "./session-bulk-run"

describe("runSessionBulk", () => {
  test("archives in order and does not check a v1 gate", async () => {
    const calls: string[] = []
    const result = await runSessionBulk({
      ids: ["a", "b"],
      op: "archive",
      isProtected: () => false,
      archive: async (id) => {
        calls.push(`archive:${id}`)
      },
      remove: async (id) => {
        calls.push(`remove:${id}`)
      },
    })
    expect(calls).toEqual(["archive:a", "archive:b"])
    expect(result).toEqual({ done: ["a", "b"], pending: [], skipped: [] })
  })

  test("deletes once per root and stops after the first failure", async () => {
    const calls: string[] = []
    const result = await runSessionBulk({
      ids: ["a", "b", "c"],
      op: "delete",
      isProtected: (id) => id === "a",
      archive: async () => {
        throw new Error("archive")
      },
      remove: async (id) => {
        calls.push(id)
        if (id === "b") throw new Error("nope")
      },
    })
    expect(calls).toEqual(["b"])
    expect(result).toEqual({ done: [], failed: "b", pending: ["c"], skipped: ["a"] })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/session-bulk-run.test.ts`
Expected: FAIL because `session-bulk-run` is missing.

- [ ] **Step 3: Write the runner**

```ts
export type BulkOp = "archive" | "delete"

export type BulkRunInput = {
  ids: readonly string[]
  op: BulkOp
  isProtected: (id: string) => boolean
  archive: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export type BulkRunResult = {
  done: string[]
  failed?: string
  pending: string[]
  skipped: string[]
}

export async function runSessionBulk(input: BulkRunInput): Promise<BulkRunResult> {
  const done: string[] = []
  const skipped: string[] = []
  for (let index = 0; index < input.ids.length; index++) {
    const id = input.ids[index]
    if (!id) continue
    if (input.isProtected(id)) {
      skipped.push(id)
      continue
    }
    try {
      if (input.op === "archive") await input.archive(id)
      else await input.remove(id)
      done.push(id)
    } catch {
      return { done, failed: id, pending: input.ids.slice(index + 1), skipped }
    }
  }
  return { done, pending: [], skipped }
}
```

Use `if / else`. One id must call archive or remove, never both.

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/app`: `bun test src/pages/session/session-bulk-run.test.ts`
Expected: PASS

### Task 3: English copy

**Files:**
- Modify: `packages/app/src/i18n/en.ts`
- Modify: `packages/app/src/context/language.tsx` `PluralKey` union

**Interfaces:**
- Consumes: nothing
- Produces: the keys below. Later tasks must use these exact keys.

Add these keys to `dict` in `en.ts`:

```ts
"session.bulk.select": "Select",
"session.bulk.cleanup": "Clean up",
"session.bulk.archive": "Archive",
"session.bulk.delete": "Delete",
"session.bulk.cancel": "Cancel",
"session.bulk.selectAll": "Select all loaded",
"session.bulk.locked": "Open or running",
"session.bulk.cleanup.empty": "No sessions are old enough.",
"session.bulk.period.1w": "1 week",
"session.bulk.period.2w": "2 weeks",
"session.bulk.period.1m": "1 month",
"session.bulk.period.3m": "3 months",
"session.bulk.period.6m": "6 months",
"session.bulk.period.1y": "1 year",
"session.bulk.selected.one": "{{count}} selected",
"session.bulk.selected.other": "{{count}} selected",
"session.bulk.delete.confirm.one": "Delete {{count}} session? This cannot be undone. Child sessions are deleted too.",
"session.bulk.delete.confirm.other": "Delete {{count}} sessions? This cannot be undone. Child sessions are deleted too.",
"session.bulk.archive.confirm.one": "Archive {{count}} session? It will be hidden.",
"session.bulk.archive.confirm.other": "Archive {{count}} sessions? They will be hidden.",
"session.bulk.cleanup.match.one": "{{count}} session not updated in {{period}}.",
"session.bulk.cleanup.match.other": "{{count}} sessions not updated in {{period}}.",
"session.bulk.cleanup.skipped.one": "{{count}} skipped because it is open or running.",
"session.bulk.cleanup.skipped.other": "{{count}} skipped because they are open or running.",
"session.bulk.failed.one": "Could not finish. {{count}} session was not changed.",
"session.bulk.failed.other": "Could not finish. {{count}} sessions were not changed.",
```

Add these bases to `PluralKey` in `packages/app/src/context/language.tsx`:

```ts
| "session.bulk.selected"
| "session.bulk.delete.confirm"
| "session.bulk.archive.confirm"
| "session.bulk.cleanup.match"
| "session.bulk.cleanup.skipped"
| "session.bulk.failed"
```

Do not edit other locale files. `language.tsx` merges English underneath them.

- [ ] **Step 1: Add the keys and plural bases**

- [ ] **Step 2: Typecheck the i18n change**

Run from `packages/app`: `bun typecheck`
Expected: exit 0. If a locale `satisfies` the full English key set, that locale file is wrong for this repo: `de.ts` uses `Partial`. Do not add invented translations to make typecheck pass.

### Task 4: Confirm dialog

**Files:**
- Create: `packages/app/src/pages/session/session-bulk-dialog.tsx`

**Interfaces:**
- Consumes: `BulkOp` from `session-bulk-run.ts`, `useLanguage`, `Dialog` from `@opencode-ai/ui/dialog`, `Button` from `@opencode-ai/ui/button`
- Produces: `BulkConfirmDialog` used by both lists through `useDialog().show`

```tsx
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { BulkOp } from "./session-bulk-run"

export function BulkConfirmDialog(props: {
  op: BulkOp
  count: number
  matchLabel?: string
  skippedLabel?: string
  empty?: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const language = useLanguage()
  const title = () => (props.op === "delete" ? language.t("session.bulk.delete") : language.t("session.bulk.archive"))
  const confirm = () =>
    props.op === "delete"
      ? language.plural("session.bulk.delete.confirm", props.count)
      : language.plural("session.bulk.archive.confirm", props.count)

  return (
    <Dialog title={title()} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <Show when={props.matchLabel}>
          <span class="text-14-regular text-text-strong">{props.matchLabel}</span>
        </Show>
        <Show when={props.skippedLabel}>
          <span class="text-12-regular text-text-weak">{props.skippedLabel}</span>
        </Show>
        <Show when={props.empty} fallback={<span class="text-14-regular text-text-strong">{confirm()}</span>}>
          <span class="text-14-regular text-text-strong">{language.t("session.bulk.cleanup.empty")}</span>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" disabled={props.busy} onClick={props.onCancel}>
            {language.t("session.bulk.cancel")}
          </Button>
          <Show when={!props.empty}>
            <Button variant="primary" size="large" disabled={props.busy || props.count === 0} onClick={props.onConfirm}>
              {title()}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
```

When `empty` is true, do not also render `confirm()`. The parent passes `empty: true` and omits the action. For a normal archive/delete confirm, pass `empty: false` and no `matchLabel`.

- [ ] **Step 1: Add the dialog component**

No new unit test. The copy keys are the contract. The runner tests cover the action.

### Task 5: Sidebar select and cleanup

**Files:**
- Modify: `packages/app/src/pages/layout/sidebar-items.tsx`
- Modify: `packages/app/src/pages/layout/sidebar-workspace.tsx`
- Modify: `packages/app/src/pages/layout/sidebar-project.tsx` only if `LocalWorkspace` is rendered there and needs no extra prop. Prefer keeping new state inside `sidebar-workspace.tsx`.

**Interfaces:**
- Consumes: `cleanupCandidates`, `presetDays`, `protectedRootIDs`, `selectLoaded`, `selectRange`, `toggleID`, `BULK_PRESETS` from `session-bulk.ts`; `runSessionBulk` from `session-bulk-run.ts`; `BulkConfirmDialog`; `listAllSessions` from `@/utils/session`; `sessionHasOpenTab` from `@/context/tabs`; `notifySessionTabsRemoved` from `@/components/titlebar-session-events`
- Produces: selection props on `SessionItem` and header controls on both `SortableWorkspace` and `LocalWorkspace`

`SessionItem` gains optional selection props. When `selecting` is true, the row click toggles and does not navigate. Child rows (`level > 0`) never show a checkbox.

```ts
selecting?: boolean
selected?: boolean
locked?: boolean
onToggle?: (event: MouseEvent) => void
```

Locked checkbox is disabled and has `aria-label={language.t("session.bulk.locked")}`. The existing hover archive button stays and is hidden while `selecting` is true so it does not fight the checkbox.

Header controls, on both workspace and local lists:

- A ghost button labeled `session.bulk.select` toggles select mode.
- A `DropdownMenu` labeled `session.bulk.cleanup` lists `BULK_PRESETS`. Each item label is `language.t(`session.bulk.period.${preset.id}`)`.
- While selecting, show a bar with `language.plural("session.bulk.selected", count)`, Select all loaded, Archive, Delete, and Cancel.

State is a store local to that workspace component:

```ts
const [bulk, setBulk] = createStore({
  selecting: false,
  selected: [] as string[],
  anchor: undefined as string | undefined,
  busy: false,
})
```

Clear it when the workspace collapses, when `active()` becomes false, and on Cancel or Escape. Escape listener exists only while `bulk.selecting` is true.

Allowed ids are loaded root ids whose id is not in `protectedRootIDs`. Protection input:

- `openRouteID`: `params.id`
- `openTabIDs`: session ids from `useTabs().store` for the current server, using `sessionHasOpenTab`
- `working`: `serverSync().session.data.session_working(id)`
- `pending`: `permission` or `question` array for that id is non-empty

Select all calls `selectLoaded(loadedOrder, allowed)`. Row click without shift calls `toggleID`. Shift-click calls `selectRange`.

Archive and Delete from the bar confirm with `BulkConfirmDialog` and the selected ids frozen at confirm open. Count is the selected ids that are still allowed at confirm open. If that count is 0, do not open an action confirm.

Clean up:

1. Set `busy` and call `listAllSessions(serverSDK().api.session, { directory, order: "desc" })`.
2. On throw, toast `common.requestFailed` and stop. Do not open a zero confirm.
3. On success, freeze `now = Date.now()`, compute `blocked` from the loaded sessions plus the fetched sessions, then `cleanupCandidates(sessions, now, presetDays(id), blocked)`.
4. Open `BulkConfirmDialog`. If `match.length === 0`, pass `empty: true` and no confirm action.
5. Otherwise pass `matchLabel` and, when `skipped.length > 0`, `skippedLabel` as two separate `language.plural` results. The confirm action runs `runSessionBulk` on `match.map((session) => session.id)`.

Archive implementation, no protocol early return:

```ts
const protocol = await serverSDK().protocol
const archived = Date.now()
if (protocol === "v1") {
  await serverSDK().client.session.update({ sessionID, directory, time: { archived } })
} else {
  await serverSDK().client.v2.session.update({ sessionID, directory, time: { archived } })
}
```

Delete implementation:

```ts
await serverSDK().api.session.remove({ sessionID })
```

After each success, splice that id out of the child session store, call `serverSync().homeSessions.remove(id)`, and `notifySessionTabsRemoved({ directory, sessionIDs: [id] })`. `isProtected` passed to the runner must read live tab, route, working, and pending state, not the set frozen at confirm open.

If `result.failed` is set, toast `language.plural("session.bulk.failed", result.pending.length + 1)` and keep `result.failed` plus `result.pending` selected. If there is no failure, clear select mode.

Disable Archive, Delete, and Clean up items while `bulk.busy` is true.

- [ ] **Step 1: Add selection props and the checkbox row in `sidebar-items.tsx`**

- [ ] **Step 2: Add the header, bar, confirm, and runner calls in `sidebar-workspace.tsx` for both `SortableWorkspace` and `LocalWorkspace`**

- [ ] **Step 3: Run the pure tests again**

Run from `packages/app`: `bun test src/pages/session/session-bulk.test.ts src/pages/session/session-bulk-run.test.ts`
Expected: PASS

### Task 6: Home select and cleanup

**Files:**
- Modify: `packages/app/src/pages/home/home-sessions-view.tsx`
- Modify: `packages/app/src/pages/home/home-sessions-controller.tsx`
- Modify: `packages/app/src/pages/home/home-sessions.tsx` only if props must be passed through

**Interfaces:**
- Consumes: the same pure functions, runner, and dialog as Task 5
- Produces: home header controls and row selection on the visible home rows

Home Select uses `records()` — the visible loaded rows — not the full index. Home Clean up uses `homeSessions().sessions(sessionLoad.data, sessionEventLoad.data)` before `retainHomeSessions` and before the 64-row slice.

If `sessionLoad.isPending` or `sessionLoad.isFetching` and there is no data, do not open a confirm. If `sessionLoad.isError`, toast `common.requestFailed` and do not open a confirm. An empty successful index opens the empty confirm.

Opening search sets `selecting` false and clears `selected`. Changing `home.server.focused()` does the same.

Place Select and a `MenuV2` Clean up menu beside the existing New session button. Use `ButtonV2` and `CheckboxV2`. While selecting, show the same bar as the sidebar: selected count, Select all loaded, Archive, Delete, and Cancel. Escape or Cancel clears it. Row click without shift calls `toggleID` and does not call `onOpenSession`. Shift-click calls `selectRange` on the visible row order.

Home protection must include child sessions even though the home index omits them. Build the `protectedRootIDs` session list from the full index plus sessions already present in `serverSync` child stores for those directories. A running or open child then locks its root.

Archive and delete use the same protocol split and `api.session.remove` as Task 5. After success, splice the id from that session's child store and call `homeSessions().remove(id)`, then `notifySessionTabsRemoved`.

Do not set `SHOW_HOME_SESSION_ARCHIVE` to true.

- [ ] **Step 1: Thread selection props from the controller to `HomeSessionRow`**

- [ ] **Step 2: Add Select, Clean up, the action bar, and the confirm flow**

The controller owns the store and the SDK calls. The view receives callbacks. Do not call the SDK from the view.

- [ ] **Step 3: Run the pure tests again**

Run from `packages/app`: `bun test src/pages/session/session-bulk.test.ts src/pages/session/session-bulk-run.test.ts`
Expected: PASS

### Task 7: Typecheck

**Files:**
- No new files. Fix only type errors introduced by Tasks 3–6.

- [ ] **Step 1: Run typecheck**

Run from `packages/app`: `bun typecheck`
Expected: exit 0

- [ ] **Step 2: Re-run the new unit tests**

Run from `packages/app`: `bun test src/pages/session/session-bulk.test.ts src/pages/session/session-bulk-run.test.ts`
Expected: PASS

## Self-review

- Spec interaction, scope, eligibility, actions, errors, copy, and tests each have a task.
- Sidebar Clean up uses `listAllSessions`, not the trimmed sidebar window.
- Home Clean up uses the index before `retainHomeSessions` and the 64-row slice. Select stays on visible rows.
- Workspace cleanup does not include sibling directories.
- Failure stops the runner and keeps the failed id plus pending ids selected.
- No restore, TUI, home per-row archive, or e2e test is in this plan.
- English copy is not concatenated into one sentence. Match and skipped are separate plural calls.

## Execution note

Commit only if the user asks. Suggested messages if they do:

- `feat(app): add session bulk eligibility`
- `feat(app): run session archive and delete in batches`
- `feat(app): select and clean up sidebar and home sessions`
