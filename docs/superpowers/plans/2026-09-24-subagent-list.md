# Subagent List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show this chat's task-tool child sessions as one collapsible list on the right and in the terminal dock, with a preview on the row and the child's messages in place when expanded.

**Architecture:** A pure helper groups children into active and finished, builds the one-line preview, and resolves the shared expanded id. Session view state owns that id and whether the finished group is open. One Solid component mounts in the right side panel and the terminal dock and reads that state. The main session route does not change.

**Tech Stack:** SolidJS, existing session sync and layout store, bun:test from `packages/app`.

## Global Constraints

- Only sessions whose `parentID` is the current session.
- One shared expanded child id. One expanded child at a time.
- Active means status `busy` or `retry`. Finished means `idle`. Missing status is finished.
- Finished children move into a group below the active ones. That group is collapsed by default.
- Expanding a finished child also opens the finished group in both mounts.
- The list is hidden when this session has no children.
- Expanded body is read-only. No second composer. No second permission dock.
- Do not navigate the main chat to the child.
- New user-visible English strings use i18n keys in `packages/app/src/i18n/en.ts`. Do not invent translations. Other locale files are `Partial` and do not need the new keys.
- Child titles and message text use `dir="auto"`. New chrome uses logical CSS, not physical left/right.
- Do not render Solid components in unit tests. `--conditions=solid` throws before component bodies. Pin contracts in source tests of the pure helper.
- Tests run from `packages/app`, never from the repo root.
- Do not commit unless the user asks.

---

### Task 1: Group, preview, and expand helper

**Files:**
- Create: `packages/app/src/pages/session/subagent-list.ts`
- Test: `packages/app/src/pages/session/subagent-list.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type SubagentStatus = "busy" | "retry" | "idle"`
  - `export type SubagentChild = { id: string; title: string; updated: number; status: SubagentStatus | undefined; text: string }`
  - `export type SubagentGroups = { active: SubagentChild[]; finished: SubagentChild[] }`
  - `export function groupSubagents(children: readonly SubagentChild[]): SubagentGroups`
  - `export function subagentPreview(text: string): string`
  - `export function expandSubagent(state: { expandedID?: string; finishedOpen: boolean }, child: { id: string; finished: boolean }): { expandedID: string; finishedOpen: boolean }`

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/pages/session/subagent-list.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { expandSubagent, groupSubagents, subagentPreview } from "./subagent-list"

const child = (
  id: string,
  status: "busy" | "retry" | "idle" | undefined,
  updated: number,
  text = "",
) => ({ id, title: id, updated, status, text })

describe("groupSubagents", () => {
  test("puts busy and retry above idle, newest first", () => {
    const groups = groupSubagents([
      child("idle-old", "idle", 1),
      child("busy-old", "busy", 2),
      child("retry-new", "retry", 4),
      child("idle-new", "idle", 3),
      child("missing", undefined, 5),
    ])
    expect(groups.active.map((item) => item.id)).toEqual(["retry-new", "busy-old"])
    expect(groups.finished.map((item) => item.id)).toEqual(["missing", "idle-new", "idle-old"])
  })
})

describe("subagentPreview", () => {
  test("uses the first line and drops extra whitespace", () => {
    expect(subagentPreview("  hello\nworld  ")).toBe("hello")
    expect(subagentPreview("")).toBe("")
    expect(subagentPreview("\n\n")).toBe("")
  })
})

describe("expandSubagent", () => {
  test("replaces the expanded id and opens the finished group for a finished child", () => {
    expect(expandSubagent({ expandedID: "a", finishedOpen: false }, { id: "b", finished: false })).toEqual({
      expandedID: "b",
      finishedOpen: false,
    })
    expect(expandSubagent({ expandedID: "a", finishedOpen: false }, { id: "c", finished: true })).toEqual({
      expandedID: "c",
      finishedOpen: true,
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/app`:

```bash
bun test src/pages/session/subagent-list.test.ts
```

Expected: FAIL because `./subagent-list` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/app/src/pages/session/subagent-list.ts`:

```ts
export type SubagentStatus = "busy" | "retry" | "idle"

export type SubagentChild = {
  id: string
  title: string
  updated: number
  status: SubagentStatus | undefined
  text: string
}

export type SubagentGroups = {
  active: SubagentChild[]
  finished: SubagentChild[]
}

export function groupSubagents(children: readonly SubagentChild[]): SubagentGroups {
  const byUpdated = (a: SubagentChild, b: SubagentChild) => b.updated - a.updated
  const active = children.filter((child) => child.status === "busy" || child.status === "retry").toSorted(byUpdated)
  const finished = children.filter((child) => child.status !== "busy" && child.status !== "retry").toSorted(byUpdated)
  return { active, finished }
}

export function subagentPreview(text: string) {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  return line ?? ""
}

export function expandSubagent(
  state: { expandedID?: string; finishedOpen: boolean },
  child: { id: string; finished: boolean },
) {
  return {
    expandedID: child.id,
    finishedOpen: state.finishedOpen || child.finished,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/app`:

```bash
bun test src/pages/session/subagent-list.test.ts
```

Expected: PASS. 3 tests.

- [ ] **Step 5: Do not commit**

Stop. The user has not asked for a commit.

### Task 2: Shared expand state

**Files:**
- Modify: `packages/app/src/context/layout.tsx` next to `todoCollapsed` (around the session view object that already has `todoCollapsed` and `terminal`)

**Interfaces:**
- Consumes: `expandSubagent` from Task 1. The layout store does not import it. The component in Task 3 calls `expandSubagent`, then writes the result here.
- Produces: on the session view object returned beside `todoCollapsed`:
  - `subagents.expandedID: () => string | undefined`
  - `subagents.setExpandedID: (id: string | undefined) => void`
  - `subagents.finishedOpen: () => boolean`
  - `subagents.setFinishedOpen: (open: boolean) => void`

- [ ] **Step 1: Add the fields**

Follow the `todoCollapsed` setter in `packages/app/src/context/layout.tsx`. When the session view record is missing, create it with `scroll: {}` and the new fields. When it exists, set the field by path.

```ts
subagents: {
  expandedID: () => s().subagentExpandedID,
  setExpandedID(id: string | undefined) {
    const session = key()
    const current = store.sessionView[session]
    if (!current) setStore("sessionView", session, { scroll: {}, subagentExpandedID: id })
    else setStore("sessionView", session, "subagentExpandedID", id)
  },
  finishedOpen: () => s().subagentFinishedOpen ?? false,
  setFinishedOpen(open: boolean) {
    const session = key()
    const current = store.sessionView[session]
    if (!current) setStore("sessionView", session, { scroll: {}, subagentFinishedOpen: open })
    else setStore("sessionView", session, "subagentFinishedOpen", open)
  },
},
```

Add optional `subagentExpandedID?: string` and `subagentFinishedOpen?: boolean` to the session view store type in the same file. Do not give them a default that opens the finished group.

- [ ] **Step 2: Typecheck**

Run from `packages/app`:

```bash
bun typecheck
```

Expected: PASS, or only errors unrelated to `layout.tsx`. Fix any error this task introduced.

- [ ] **Step 3: Do not commit**

### Task 3: List component and both mounts

**Files:**
- Create: `packages/app/src/pages/session/subagent-list.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Modify: `packages/app/src/pages/session/session-side-panel.tsx`
- Modify: `packages/app/src/pages/session/terminal-panel.tsx`
- Modify: `packages/app/src/pages/session/terminal-panel-v2.tsx`
- Modify: `packages/app/src/pages/session.tsx` only if that is where the terminal dock is composed and the panel files cannot host the section

**Interfaces:**
- Consumes: `groupSubagents`, `subagentPreview`, `expandSubagent` from Task 1. `view().subagents` from Task 2.
- Produces: `export function SubagentList(props: { sessionID: () => string })`. Both mounts render `<SubagentList sessionID={...} />`. The component returns `null` when there are no children.

- [ ] **Step 1: Add i18n keys**

In `packages/app/src/i18n/en.ts`, add:

```ts
"session.subagents.tasks": "Tasks",
"session.subagents.finished": "Finished",
"session.subagents.running": "Running",
"session.subagents.idle": "Idle",
```

Do not add these keys to other locale files. They are `Partial`.

- [ ] **Step 2: Build the child rows from sync**

In `subagent-list.tsx`, read sessions from the existing sync store used by `packages/app/src/pages/session.tsx` (`sync().data.session`). Keep children where `parentID === props.sessionID()`.

Map each child to `SubagentChild`:

- `id` from the session id
- `title` from the session title
- `updated` from `time.updated`
- `status` from the session status store if the page already has one (`busy`, `retry`, or `idle`). If you cannot find a per-session status map, pass `undefined`. Do not invent a busy signal. Missing status is finished.
- `text` from the latest text part in `sync().data.part[childID]`. Walk parts from the end. Use the first string text field. If none, use `""`

Call `groupSubagents`. If `active.length + finished.length === 0`, return `null`.

- [ ] **Step 3: Render the two groups**

Active rows first. Then a disclosure button labeled with `language.t("session.subagents.finished")` and the finished count. The disclosure is open only when `view().subagents.finishedOpen()` is true. Clicking it calls `setFinishedOpen(!finishedOpen())`.

Each row button shows:

- title in `<bdi dir="auto">`
- status label: `session.subagents.running` for `busy` and `retry`, `session.subagents.idle` for finished
- preview from `subagentPreview(child.text)` in `<bdi dir="auto">`

Clicking a row calls `expandSubagent` with `finished: true` when the child is in the finished group, then `setExpandedID(result.expandedID)` and `setFinishedOpen(result.finishedOpen)`.

When `expandedID()` equals the row id, render that child's messages under the row. Reuse the existing read-only message list if one is already exported. If the only message list mounts the composer, do not use it. Render the text parts in order inside `<div dir="auto">` instead. No composer. No permission controls.

Use logical classes only (`ps-`, `pe-`, `border-s`, `text-start`). Do not add `pl-`, `pr-`, `left-`, or `right-` for this list.

- [ ] **Step 4: Mount it twice**

Right panel: in `SessionSidePanel`, add a Tasks tab next to the file browser tab. Label it with `language.t("session.subagents.tasks")`. The tab panel renders `<SubagentList sessionID={() => params.id} />`. Hide the Tasks tab when `SubagentList` would return null. Do that by exporting `hasSubagents(sessionID, sessions)` from `subagent-list.ts` that returns whether any session has that `parentID`, and use it for the tab. Do not mount a second copy of the grouping logic in the panel.

Terminal dock: in both `terminal-panel.tsx` and `terminal-panel-v2.tsx`, render the same `<SubagentList sessionID={...} />` in the dock chrome, not instead of the terminal. Collapsing the terminal must not clear `subagentExpandedID`. The list's own null return hides it when there are no children.

Pass the open session id already available in those files. Do not read a new route param.

- [ ] **Step 5: Clear a deleted expanded child**

In `SubagentList`, if `expandedID()` is set and that id is not in the child list, call `setExpandedID(undefined)` from an effect. Do not navigate.

- [ ] **Step 6: Typecheck and run the helper test**

From `packages/app`:

```bash
bun test src/pages/session/subagent-list.test.ts
bun typecheck
```

Expected: helper tests PASS. Typecheck PASS, or only pre-existing errors outside the files in this task. Fix errors this task introduced.

- [ ] **Step 7: Do not commit**

## Spec coverage

- Child sessions only: Task 3 filter on `parentID`.
- Shared component, two mounts: Task 3.
- Shared expanded id, one at a time: Task 1 `expandSubagent` plus Task 2 store. The component always replaces the id.
- Preview and groups: Task 1.
- Finished group collapsed by default: Task 2 default `false`.
- Expanding a finished child opens the group: Task 1 `finishedOpen: state.finishedOpen || child.finished`.
- Hidden when no children: Task 3 `null` and `hasSubagents`.
- Loading row with empty body: Task 3 empty text and empty expanded body.
- Deleted child drops the row and clears expand: Task 3 effect.
- No main-chat navigation: no route write in any task.
- No second composer or permission dock: Task 3 forbids those mounts.
- i18n and RTL: Task 3.
- Source tests, no Solid render: Task 1.

## Execution note

Do not start these tasks until the user picks an execution option.
