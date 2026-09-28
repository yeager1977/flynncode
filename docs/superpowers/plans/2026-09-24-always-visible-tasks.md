# Always-Visible Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the right-side Tasks tab selectable for every session and explain where delegated work will appear before the session has child tasks.

**Architecture:** The side-panel tab trigger becomes unconditional in both legacy and V2 branches. `SubagentList` decides between its existing grouped rows and an i18n-backed empty state through a small pure helper, preserving its current task/session data flow. The terminal dock continues using `sessionShowsSubagents` and remains hidden when there are no tasks.

**Tech Stack:** SolidJS, TypeScript, Bun tests, app i18n dictionaries, Electron Builder Debian packaging.

## Global Constraints

- Keep the terminal-dock task section conditional; only the right-side tab is always available.
- Use existing layout tokens and logical CSS properties; do not add a setting or physical left/right positioning.
- All new visible copy uses `language.t(...)` and must be present in every app locale.
- Do not commit unless the user explicitly requests one.
- Run app tests and `bun typecheck` from `packages/app`; verify the Debian artifact after packaging.

---

### Task 1: Model Empty Task Content

**Files:**
- Modify: `packages/app/src/pages/session/subagent-list.ts`
- Modify: `packages/app/src/pages/session/subagent-list.test.ts`

**Interfaces:**
- Consumes: `SubagentChild[]` created from child sessions and task parts.
- Produces: `subagentListState(children: readonly SubagentChild[]): "empty" | "list"`, used by `SubagentList` to choose its content.

- [ ] **Step 1: Write the failing test**

```ts
import { subagentListState } from "./subagent-list"

describe("subagentListState", () => {
  test("shows the empty state until a child exists", () => {
    expect(subagentListState([])).toBe("empty")
    expect(subagentListState([child("child", "busy", 1)])).toBe("list")
  })
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun test src/pages/session/subagent-list.test.ts`

Expected: TypeScript reports that `subagentListState` is not exported.

- [ ] **Step 3: Add the minimal pure helper**

```ts
export function subagentListState(children: readonly SubagentChild[]) {
  return children.length === 0 ? "empty" : "list"
}
```

Place it below `groupSubagents`. Do not change `sessionShowsSubagents`; terminal panels still depend on it to remain conditional.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun test src/pages/session/subagent-list.test.ts`

Expected: all subagent list tests pass.

### Task 2: Keep the Right-Side Tab Visible

**Files:**
- Modify: `packages/app/src/pages/session/subagent-list-view.tsx`
- Modify: `packages/app/src/pages/session/session-side-panel.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Modify: every other `packages/app/src/i18n/*.ts` locale dictionary

**Interfaces:**
- Consumes: `subagentListState(rows())`, `language.t("session.subagents.empty")`.
- Produces: a Tasks tab that is always in the right-side tab list and an explanatory empty view when `rows()` has no child tasks.

- [ ] **Step 1: Write the failing i18n parity expectation**

Add the English source key before updating locale fallbacks:

```ts
"session.subagents.empty": "Delegated tasks will appear here.",
```

Run: `bun test src/i18n/parity.test.ts`

Expected: FAIL because each non-English locale lacks `session.subagents.empty`.

- [ ] **Step 2: Add locale-complete copy**

Add `session.subagents.empty` to every locale dictionary. Use the established terminology for each locale's equivalent of “delegated tasks”; preserve the exact key in all dictionaries. Confirm parity before continuing.

- [ ] **Step 3: Render the empty state in `SubagentList`**

Replace the outer conditional-only rendering with a `Show` fallback that retains the existing list unchanged when rows exist:

```tsx
<Show
  when={subagentListState(rows()) === "list"}
  fallback={<div class="p-2 text-12-regular text-text-weak">{language.t("session.subagents.empty")}</div>}
>
  <div class="flex flex-col gap-2 p-2 text-12-regular text-text-base">
    <For each={groups().active}>{(child) => <Row child={child} finished={false} open={open} />}</For>
    <Show when={groups().finished.length > 0}>
      <button
        type="button"
        class="text-start text-text-weak"
        aria-expanded={view().subagents.finishedOpen()}
        onClick={() => view().subagents.setFinishedOpen(!view().subagents.finishedOpen())}
      >
        {language.t("session.subagents.finished")} {groups().finished.length}
      </button>
      <Show when={view().subagents.finishedOpen()}>
        <For each={groups().finished}>{(child) => <Row child={child} finished={true} open={open} />}</For>
      </Show>
    </Show>
  </div>
</Show>
```

Import `subagentListState` from `./subagent-list`. Do not render the empty state in either terminal-panel mount because those mounts remain gated by `sessionShowsSubagents`.

- [ ] **Step 4: Remove only the two side-panel visibility gates**

In both legacy and V2 tab lists in `session-side-panel.tsx`, replace:

```tsx
<Show when={showTasks()}>
  <Tabs.Trigger value="tasks">{language.t("session.subagents.tasks")}</Tabs.Trigger>
</Show>
```

with:

```tsx
<Tabs.Trigger value="tasks">{language.t("session.subagents.tasks")}</Tabs.Trigger>
```

Keep `showTasks` only where it is still needed. If it has no remaining use in this file, remove its memo and `sessionShowsSubagents` import. Retain the `tasksSelected()` tab-content mounts so the panel opens only when the user selects Tasks.

- [ ] **Step 5: Verify app-level contracts**

Run: `bun test src/pages/session/subagent-list.test.ts src/i18n/parity.test.ts`

Expected: source state test and locale parity both pass.

### Task 3: Verify and Package

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: completed app source and locale changes.
- Produces: a validated Debian package under `packages/desktop/dist/`.

- [ ] **Step 1: Run focused session and prompt-input tests**

Run: `bun test --conditions=solid --preload ./happydom.ts src/components/prompt-input src/pages/session`

Expected: 0 failures.

- [ ] **Step 2: Run the app type check**

Run: `bun typecheck`

Expected: exits 0.

- [ ] **Step 3: Build and package Linux artifacts**

Run from `packages/desktop`: `bun run build && bun run package:linux`

Expected: the Debian package and AppImage are regenerated. The packaging script may exit nonzero only because `rpmbuild` is unavailable; in that case confirm the generated `.deb` exists before reporting packaging status.

- [ ] **Step 4: Confirm the Debian output**

Run from the repository root:

```bash
dpkg-deb -f packages/desktop/dist/opencode-desktop-linux-amd64.deb Package Version Architecture
```

Expected: reports `Package: opencode-dev` and `Architecture: amd64`.
