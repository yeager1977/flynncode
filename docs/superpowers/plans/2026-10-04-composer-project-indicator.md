# Composer Project Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a project indicator (avatar + name) at the head of the composer bottom bar; clicking opens a read-only popover with avatar, name, worktree path, and session count.

**Architecture:** Follow the `modelControl` slot pattern: session-ui's `PromptInputV2` gains a generic `projectControl?: JSX.Element` slot rendered first in the left control group; the app supplies a `PromptInputV2ProjectControl` button + read-only popover via `app/src/components/prompt-input-v2.tsx`.

**Tech Stack:** SolidJS, SolidJS createStore/createMemo, Kobalte popover (via `@opencode-ai/ui/popover`), Bun test (source-contract style).

## Global Constraints

- NEVER hardcode user-visible English strings — always `language.t(...)`; new keys: `session.project.path`, `session.project.sessions`, `session.project.open`, plus fallback-file spread for all locales (pattern: `packages/app/src/i18n/session-review-fallback.ts`).
- Do not translate from model knowledge; do not change existing en copy.
- Logical CSS properties only (no physical left/right margins) — the control flows in the existing flex row.
- Run tests from package dirs, never repo root (`do-not-run-tests-from-root` guard).
- Typecheck with `bun typecheck` from `packages/session-ui` and `packages/app`, never raw `tsc`.
- Avoid `else`; prefer `const` + ternaries/early returns; avoid unnecessary destructuring; no aliased or star imports; inline single-use values.
- Conventional commits, scope `app` or `session-ui` as appropriate.

---

### Task 1: session-ui `projectControl` slot

**Files:**
- Modify: `packages/session-ui/src/v2/components/prompt-input/index.tsx` (~line 38-46 props, ~line 206-217 render)

**Interfaces:**
- Consumes: existing `PromptInputV2Props` shape.
- Produces: `PromptInputV2Props.projectControl?: JSX.Element` — rendered as the first child of the inner control-row `<div>` (before `<PromptInputV2AddMenu ...>`). Later tasks pass content through it.

- [ ] **Step 1: Write the failing test**

Add to `packages/session-ui/src/v2/components/prompt-input/machine.test.ts` (it is a bun unit-test file that already exists):

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8")

describe("PromptInputV2 projectControl slot", () => {
  test("renders the project control before the add menu", () => {
    expect(source).toContain('projectControl?: JSX.Element')
    expect(source.indexOf("props.projectControl")).toBeLessThan(source.indexOf("<PromptInputV2AddMenu"))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/session-ui`: `bun test src/v2/components/prompt-input/machine.test.ts`
Expected: FAIL — "projectControl" not in source.

- [ ] **Step 3: Write minimal implementation**

In `PromptInputV2Props` add:

```ts
  projectControl?: JSX.Element
```

In the render, immediately inside the left control-group `div` (the one with `aria-hidden={state.mode === "shell"}`), before `<PromptInputV2AddMenu`:

```tsx
            <Show when={props.projectControl} keyed>
              {(control) => control}
            </Show>
```

- [ ] **Step 4: Run test to verify it passes**

Run from `packages/session-ui`: `bun test src/v2/components/prompt-input/machine.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run from `packages/session-ui`: `bun typecheck`
Expected: no errors.

```bash
git add packages/session-ui/src/v2/components/prompt-input/index.tsx packages/session-ui/src/v2/components/prompt-input/machine.test.ts
git commit -m "feat(session-ui): add projectControl slot to prompt input v2"
```

---

### Task 2: i18n keys and fallback

**Files:**
- Modify: `packages/app/src/i18n/en.ts` (near the `session.bulk.*` block, ~line 1456)
- Modify: `packages/app/src/i18n/session-review-fallback.ts` (key filter list)

**Interfaces:**
- Produces: i18n keys consumed by Task 3's component: `session.project.path`, `session.project.sessions`, `session.project.open`.

- [ ] **Step 1: Add keys to en.ts**

Insert after the `session.bulk.failed.*` lines in `packages/app/src/i18n/en.ts`:

```ts
  "session.project.open": "Project",
  "session.project.path": "Worktree",
  "session.project.sessions": "{{count}} sessions",
```

- [ ] **Step 2: Add plural fallbacks for session.project.sessions**

`language.plural` needs `{{count}}`-carrying `.other` (and `one`) variants. `pluralFamilies` in `parity.test.ts` detects families from `.one`+`.other`. In `packages/app/src/i18n/session-review-fallback.ts` add to the filter list:

```ts
      key.startsWith("session.project.") ||
```

And add a plural fallback export at the bottom of the file (mirroring `sessionBulkPluralFallback`'s role — check `packages/app/src/i18n/session-bulk-fallback.ts` for the exact structure of per-locale plural variant maps; for `session.project.sessions` the simple form below suffices because every locale's fallback equals English):

In `packages/app/src/i18n/session-review-fallback.ts` append:

```ts
export const sessionProjectPluralFallback = {
  // Pending translation. Every locale spreads this so the plural family
  // resolves before translations land.
  sessions: {
    one: "{{count}} session",
    other: "{{count}} sessions",
  },
}
```

Then in every locale file `packages/app/src/i18n/<locale>.ts`, spread it after `...sessionReviewFallback`:

```ts
  ...sessionProjectPluralFallback.sessions,
```

Use this Perl loop pattern (already proven in this repo):

```bash
cd packages/app/src/i18n && for l in am ar az bg bn br bs ca cs da de dv dz el es et fa fi fo fr hi hr hu hy id is it ja ka km ko lo lt lv mk mn ms my ne nl no pa pl ro ru si sk sl sq sr sv tg th tk tr uk ur uz vi zh zht; do
  perl -pi -e 's/^(\s*\.\.\.sessionReviewFallback,\n)$/$1  ...sessionProjectPluralFallback.sessions,\n/' $l.ts
done
```

Also update the import line in each locale file:

```bash
cd packages/app/src/i18n && for l in am ar az bg bn br bs ca cs da de dv dz el es et fa fi fo fr hi hr hu hy id is it ja ka km ko lo lt lv mk mn ms my ne nl no pa pl ro ru si sk sl sq sr sv tg th tk tr uk ur uz vi zh zht; do
  perl -pi -e 's/^import \{ sessionReviewFallback \} from "\.\/session-review-fallback"$/import { sessionReviewFallback, sessionProjectPluralFallback } from ".\/session-review-fallback"/' $l.ts
done
```

- [ ] **Step 3: Run parity test**

Run from `packages/app`: `bun test src/i18n/parity.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/i18n/
git commit -m "feat(app): add project indicator i18n keys"
```

---

### Task 3: `PromptInputV2ProjectControl` in app

**Files:**
- Modify: `packages/app/src/components/prompt-input-v2.tsx`
- Test: extend/add `packages/app/src/components/prompt-input-v2.test.ts` (create it; source-contract style like `session-todo-dock.test.tsx`)

**Interfaces:**
- Consumes: Task 1's `projectControl` slot; `useLayout()` → `layout.projects.list()` (returns `LocalProject[] = Partial<Project> & { worktree: string; expanded: boolean }`, enriched with `name?`, `id?`, `icon? { color?: string; url?: string; override?: string }`); `useServerSync()` → `serverSync().child(worktree, { bootstrap: false })[0].session` (array with `time.archived`), `serverSync().data.project` (array with `worktree`, `sandboxes?: string[]`); helpers `displayName` and `getProjectAvatarVariant` from `@/context/layout`, `getProjectAvatarSource` from `@/pages/layout/helpers`; `ProjectAvatar` from `@opencode-ai/ui/v2/project-avatar-v2`; `Popover` from `@opencode-ai/ui/popover`; `ButtonV2` from `@opencode-ai/ui/v2/button-v2`; `TooltipV2` from `@opencode-ai/ui/v2/tooltip-v2`; `Icon as IconV2` from `@opencode-ai/ui/v2/icon`; `getFilename` from `@opencode-ai/core/util/path`.
- Produces: `PromptInputV2ProjectControl` (exported) and a wiring change in `PromptInputV2Composer` passing the new control into `PromptInputV2`'s `projectControl` prop. Task 4 consumes the composer behavior.

Component contract (all details the implementer needs):

- Resolve the project from the route directory. `PromptInputV2Composer` already has access to `useLayout()` and `useServerSync()` via the controller hook context; the composer itself must add those two context reads plus `useServerSync` if missing. Directory used for lookup: `sdk().directory` is available inside `usePromptInputV2Controller`, but the composer render path (props only) does not have it — so resolve inside the composer by reading `useSDK()` there.
- Resolution memo:

```ts
const project = createMemo(() => {
  const directory = sdk().directory
  if (!directory) return undefined
  return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
})
```

- Session count memo (per spec: count non-archived sessions of the project's worktree store, omit row when store shape unavailable):

```ts
const sessions = createMemo(() => {
  const target = project()
  if (!target) return undefined
  return serverSync().child(target.worktree, { bootstrap: false })[0].session ?? []
})
const activeCount = createMemo(() => sessions()?.filter((session) => session.time.archived === undefined).length)
```

- Render (new component placed below `PromptInputV2ModelControl` in the same file, matching its style conventions):

```tsx
function PromptInputV2ProjectControl(props: {
  name: string
  avatarSource?: string
  avatarVariant: ProjectAvatarVariant
  worktree: string
  sessions: number | undefined
  restoreFocus: () => void
}) {
  const language = useLanguage()
  const shown = createSignal(false)
  const content = () => (
    <>
      <ProjectAvatar
        fallback={props.name}
        src={props.avatarSource}
        class="size-4 shrink-0"
        variant={props.avatarVariant}
      />
      <span class="truncate leading-4">{props.name}</span>
      <span class="-ml-0.5 -mr-1 flex shrink-0">
        <IconV2 name="chevron-down" />
      </span>
    </>
  )
  return (
    <Popover
      open={shown[0]()}
      onOpenChange={shown[1]}
      triggerAs={ButtonV2}
      triggerProps={{
        variant: "ghost-muted",
        size: "normal",
        class: "min-w-0 max-w-[220px] justify-start ![font-weight:440] group",
        "data-action": "prompt-project",
        "data-control-type": "popover",
        style: { height: "28px" },
      }}
      trigger={
        <>
          {content()}
        </>
      }
      class="w-[280px] max-w-[calc(100vw-40px)]"
      gutter={6}
      placement="top-start"
    >
      <div class="flex flex-col gap-3 p-3">
        <div class="flex items-center gap-2 min-w-0">
          <ProjectAvatar fallback={props.name} src={props.avatarSource} class="size-6 shrink-0" variant={props.avatarVariant} />
          <span class="text-14-regular text-text-strong truncate min-w-0">{props.name}</span>
        </div>
        <div class="flex items-center justify-between gap-2 min-w-0">
          <span class="text-12-regular text-text-weak">{language.t("session.project.path")}</span>
          <span class="text-12-regular text-text-strong truncate min-w-0 font-mono">{props.worktree}</span>
        </div>
        <Show when={props.sessions !== undefined}>
          <div class="flex items-center justify-between gap-2 min-w-0">
            <span class="text-12-regular text-text-weak">{language.t("session.project.sessions_other" as never)}</span>
            <span class="text-12-regular text-text-strong">{props.sessions}</span>
          </div>
        </Show>
      </div>
    </Popover>
  )
}
```

IMPORTANT correction above: do NOT use `language.t("session.project.sessions_other")` with a raw number. Use `language.plural("session.project.sessions", count)` for the full phrase and render it as a single row (value inside the phrase):

```tsx
<Show when={props.sessions !== undefined}>
  <span class="text-12-regular text-text-weak">
    {language.plural("session.project.sessions", props.sessions ?? 0)}
  </span>
</Show>
```

Also wrap the trigger button in `TooltipV2` (placement top, label `language.t("session.project.open")`) exactly like `PromptInputV2ModelControl` wraps its button — tooltip only when the button is rendered.

- Wire in `PromptInputV2Composer`: resolve `project`, `activeCount`, and only pass when the project resolves AND a display name exists. Use `displayName(project())` from `@/pages/layout/helpers` (it handles name || getFilename|| worktree). Avatar source/variant: `getProjectAvatarSource(project.id, project.icon)` and `getProjectAvatarVariant(project.icon?.color)`.
- Visibility: when `project()` is undefined, pass `projectControl={undefined}` (control absent, no layout shift).

- [ ] **Step 1: Write the failing source-contract test**

Create `packages/app/src/components/prompt-input-v2.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./prompt-input-v2.tsx", import.meta.url), "utf8")

describe("PromptInputV2Composer project control", () => {
  test("resolves the project from the route directory and hides when absent", () => {
    expect(source).toContain("projectControl={")
    expect(source).toContain('data-action="prompt-project"')
    expect(source).toContain('language.t("session.project.open")')
    expect(source).toContain('language.plural("session.project.sessions"')
    expect(source).toContain('language.t("session.project.path")')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test src/components/prompt-input-v2.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement (as specified above)**

Wire slot + control per the contract. Imports needed in `prompt-input-v2.tsx` (check existing ones first — `Show`, `createMemo`, `createSignal`, providers/popover may already be imported):

```ts
import { Popover } from "@opencode-ai/ui/popover"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { ProjectAvatar, type ProjectAvatarVariant } from "@opencode-ai/ui/v2/project-avatar-v2"
import { useServerSync } from "@/context/server-sync"
import { displayName } from "@/pages/layout/helpers"
```

`getFilename` is already imported from `@opencode-ai/core/util/path` only in session-header — import it here only if `displayName` import is not used directly.

- [ ] **Step 4: Run test to verify it passes**

Run from `packages/app`: `bun test src/components/prompt-input-v2.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full unit suite**

Run from `packages/app`: `bun typecheck && bun run test:unit`
Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/components/prompt-input-v2.tsx packages/app/src/components/prompt-input-v2.test.ts
git commit -m "feat(app): show project indicator in composer bottom bar"
```

---

### Task 4: New-session view wiring

**Files:**
- Modify: `packages/app/src/pages/new-session/new-session-view.tsx` (line ~44 `<PromptInputV2Composer controller={props.input} />`)

**Interfaces:**
- Consumes: Task 3's composer behavior (self-contained — the composer resolves the project itself from `sdk().directory`; nothing to pass).
- Produces: nothing new; verification only.

The resolution uses `sdk().directory`. On the new-session screen that directory is the target project (the workspace controller has already selected it), so Task 3's composer-level resolution works in both places with zero extra wiring. This task is verification-only.

- [ ] **Step 1: Verify manually per dev-server instructions in packages/app/AGENTS.md**

Backend: `bun run ./src/index.ts serve --port 4096` from `packages/flynncode`; App: `bun dev -- --port 4444` from `packages/app`; open `http://localhost:4444`.
Check: session view shows project left of model; popover shows path + sessions; new-session screen shows the selected project; no project → control absent.
DO NOT restart any server process while it runs (per AGENTS.md debugging rule).

- [ ] **Step 2: Commit (nothing to commit unless fixes were needed)**

```bash
git status --short
```

Expected: only pre-existing unrelated changes.

---

## Self-review notes

- Spec coverage: slot (T1), i18n (T2), indicator component + data sources (T3), new-session (T4 verify), RTL (flows in flex row — no margins used), error handling (absent project → absent control; unavailable count → row hidden).
- No placeholders; all code shown.
- Type consistency: `PromptInputV2Props.projectControl?: JSX.Element` (T1) consumed by T3; `LocalProject`, `displayName`, `getProjectAvatarVariant`, `getProjectAvatarSource` signatures verified against current source.