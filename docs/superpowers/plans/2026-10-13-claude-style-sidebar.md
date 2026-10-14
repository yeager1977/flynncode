# Claude-style Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the new layout's project rail + titlebar tab strip with one Claude-desktop-style sidebar column where sessions, grouped by project, are the navigation.

**Architecture:** Sessions stop being tabs: the two route effects that append session tabs are removed and the titlebar strip is unmounted; the route alone drives the main view. A new `SessionSidebar` column lists `layout.projects.list()` as collapsible headers (using the existing persisted `LocalProject.expanded`) and renders each project's sessions with the existing `LocalWorkspace` list in a new `inline` mode. Draft tabs stay as hidden routing state.

**Tech Stack:** SolidJS, @solidjs/router, TanStack Solid Query, Bun test + happy-dom, `@flynncode/ui` v2 components.

Spec: `docs/superpowers/specs/2026-10-13-claude-style-sidebar-design.md`

## Global Constraints

- Follow `AGENTS.md` style: no `else`, no destructuring, no aliased/star imports, `const` over `let`, minimal single-use helpers.
- Run tests from `packages/app` only: `bun test --conditions=solid --preload ./happydom.ts <files>`; typecheck with `bun typecheck` in `packages/app`.
- Do not delete `TitlebarTabStrip`, the rail, or peek code; only unmount them.
- Do not touch the classic layout (`newLayoutDesigns() === false` paths).
- Conventional commits `type(scope): summary`, scope `app`. Commit only when the owner asks.

---

### Task 1: Sessions stop opening tabs

**Files:**
- Modify: `packages/app/src/pages/session.tsx:272-291` (`ResolvedTargetSessionRoute`)
- Modify: `packages/app/src/components/titlebar.tsx:250-263` (route→tab effect), `:408-423` (strip mount)
- Modify: `packages/app/src/pages/layout-new-sidebar.tsx:125-138` (`openSession`)
- Modify: `packages/app/src/pages/layout/new-layout-sidebar.ts:87-97` (delete now-unused `sessionTabStep` and its test cases)

**Interfaces:**
- Produces: navigating to `/server/:serverKey/session/:id` no longer mutates `tabs.store`.

- [ ] **Step 1: Remove the tab-adding effect in `ResolvedTargetSessionRoute`.** Delete the `createEffect(() => { ... tabs.addSessionTab(...) })` block and the now-unused `const tabs = useTabs()` line (keep the import only if still used elsewhere in the file).

- [ ] **Step 2: Remove the titlebar's add-tab branch.** In `components/titlebar.tsx` replace the effect body so it only remembers matching tabs:

```ts
createEffect(() => {
  layout.route()
  if (!tabs.ready()) return
  const tab = currentTab()
  if (tab) tabs.remember(tab)
})
```

- [ ] **Step 3: Unmount the strip.** Delete the `<TitlebarTabStrip ... />` JSX block and its `tabsAreOverflowing` signal; leave a flexible spacer so the right-side actions stay right-aligned:

```tsx
<div class="flex-1 min-w-0" />
```

Remove the `TitlebarTabStrip` import if it becomes unused. Keep the home toggle and the "new session" (+) button.

- [ ] **Step 4: Sidebar `openSession` navigates directly.** In `layout-new-sidebar.tsx`:

```ts
openSession: (_, id) => navigate(sessionHref(server.key, id)),
```

Delete `sessionTabStep` from `new-layout-sidebar.ts` and its cases in `pages/layout/helpers.test.ts`/`sidebar-navigation.test.ts` (whichever imports it — `grep -rn sessionTabStep packages/app/src`).

- [ ] **Step 5: Verify.** `cd packages/app && bun typecheck` → no errors. `bun run test:unit` → all pass.

---

### Task 2: Visible-session order helper

**Files:**
- Modify: `packages/app/src/pages/layout/new-layout-sidebar.ts`
- Test: `packages/app/src/pages/layout/new-layout-sidebar.test.ts` (create if absent)

**Interfaces:**
- Produces: `visibleSessionOrder(groups: { expanded: boolean; sessions: readonly T[] }[]): T[]` — sessions of expanded projects, in project order then list order. Used by Task 4.

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, test } from "bun:test"
import { visibleSessionOrder } from "./new-layout-sidebar"

describe("visibleSessionOrder", () => {
  test("flattens expanded projects in order and skips collapsed ones", () => {
    expect(
      visibleSessionOrder([
        { expanded: true, sessions: ["a1", "a2"] },
        { expanded: false, sessions: ["b1"] },
        { expanded: true, sessions: ["c1"] },
      ]),
    ).toEqual(["a1", "a2", "c1"])
  })
  test("empty when nothing is expanded", () => {
    expect(visibleSessionOrder([{ expanded: false, sessions: ["a"] }])).toEqual([])
  })
})
```

- [ ] **Step 2:** `bun test --conditions=solid --preload ./happydom.ts src/pages/layout/new-layout-sidebar.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement.**

```ts
// Mod+1-9 order: what the sidebar shows, top to bottom.
export function visibleSessionOrder<T>(groups: readonly { expanded: boolean; sessions: readonly T[] }[]): T[] {
  return groups.flatMap((group) => (group.expanded ? [...group.sessions] : []))
}
```

- [ ] **Step 4:** Re-run → PASS.

---

### Task 3: `SessionSidebar` column

**Files:**
- Create: `packages/app/src/pages/layout/session-sidebar.tsx`
- Modify: `packages/app/src/pages/layout/sidebar-workspace.tsx:1258-1326` (`LocalWorkspace` gains `inline?: boolean`)
- Modify: `packages/app/src/pages/layout/sidebar-controller.tsx:1712` (return `workspaceSidebarCtx` and `sortNow`)
- Modify: `packages/app/src/pages/layout-new-sidebar.tsx` (render `SessionSidebar` instead of `SidebarContent`; closed width 0; drop peek overlay)

**Interfaces:**
- Consumes: `createSidebarController(...)` result (`projects`, `chooseProject`, `newSession` via host, `workspaceSidebarCtx`, `sortNow`).
- Produces: `SessionSidebar(props: { sidebar: SidebarController; mobile?: boolean; onNewSession: (directory: string) => void })` where `type SidebarController = ReturnType<typeof createSidebarController>` (export that type from `sidebar-controller.tsx`).

- [ ] **Step 1: `LocalWorkspace` inline mode.** Add `inline?: boolean` to its props. When inline, the outer div must not scroll or claim the scroll ref:

```tsx
<div
  ref={(el) => {
    if (!props.inline) props.ctx.setScrollContainerRef(el, props.mobile)
  }}
  class="flex flex-col"
  classList={{ "size-full py-2 overflow-y-auto no-scrollbar [overflow-anchor:none]": !props.inline }}
>
```

- [ ] **Step 2: Expose controller pieces.** In the controller's returned object add `workspaceSidebarCtx,` and `sortNow,`; add `export type SidebarController = ReturnType<typeof createSidebarController>` after the function.

- [ ] **Step 3: Create `session-sidebar.tsx`.**

```tsx
import { For, Show } from "solid-js"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Icon } from "@flynncode/ui/v2/icon"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSettingsDialog } from "@/components/settings-dialog"
import { LocalWorkspace } from "./sidebar-workspace"
import type { SidebarController } from "./sidebar-controller"

// Claude-desktop-style navigation: one column, projects as collapsible
// headers, their sessions underneath. Clicking a session only routes.
export function SessionSidebar(props: {
  sidebar: SidebarController
  mobile?: boolean
  onNewSession: (directory: string) => void
}) {
  const layout = useLayout()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettingsDialog()
  const current = () => props.sidebar.currentProject()?.worktree ?? layout.projects.list()[0]?.worktree

  return (
    <div class="size-full flex flex-col bg-v2-background-bg-deep">
      <div class="flex flex-col gap-0.5 p-2">
        <ButtonV2
          variant="ghost-muted"
          class="justify-start"
          data-action="sidebar-new-session"
          disabled={!current()}
          onClick={() => {
            const directory = current()
            if (directory) props.onNewSession(directory)
          }}
        >
          <Icon name="edit" />
          {language.t("command.session.new")}
        </ButtonV2>
        <ButtonV2
          variant="ghost-muted"
          class="justify-start"
          data-action="sidebar-search"
          onClick={() => command.trigger("command.palette")}
        >
          <Icon name="magnifying-glass" />
          {language.t("home.sessions.search.placeholder")}
        </ButtonV2>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2">
        <For each={layout.projects.list()}>
          {(project) => (
            <div class="flex flex-col">
              <div class="group flex items-center h-8 rounded-md hover:bg-v2-background-bg-layer-01">
                <button
                  type="button"
                  class="flex-1 min-w-0 flex items-center gap-1.5 px-2 h-full text-left"
                  data-action="sidebar-project-toggle"
                  aria-expanded={project.expanded}
                  onClick={() =>
                    project.expanded
                      ? layout.projects.collapse(project.worktree)
                      : layout.projects.expand(project.worktree)
                  }
                >
                  <span class="shrink-0" classList={{ "-rotate-90": !project.expanded }}>
                    <Icon name="chevron-down" />
                  </span>
                  <span class="truncate font-medium">{project.name || project.worktree.split("/").pop()}</span>
                </button>
                <button
                  type="button"
                  class="opacity-0 group-hover:opacity-100 px-2 h-full"
                  data-action="sidebar-project-new-session"
                  aria-label={language.t("command.session.new")}
                  onClick={() => props.onNewSession(project.worktree)}
                >
                  <Icon name="plus" />
                </button>
              </div>
              <Show when={project.expanded}>
                <LocalWorkspace
                  ctx={props.sidebar.workspaceSidebarCtx}
                  project={project}
                  sortNow={props.sidebar.sortNow}
                  mobile={props.mobile}
                  inline
                />
              </Show>
            </div>
          )}
        </For>
      </div>
      <div class="flex flex-col gap-0.5 p-2 border-t border-v2-border-border-weak">
        <ButtonV2 variant="ghost-muted" class="justify-start" onClick={() => props.sidebar.chooseProject()}>
          <Icon name="folder-add-left" />
          {language.t("command.project.open")}
        </ButtonV2>
        <ButtonV2 variant="ghost-muted" class="justify-start" onClick={() => settings()}>
          <Icon name="settings-gear" />
          {language.t("command.settings.open")}
        </ButtonV2>
      </div>
    </div>
  )
}
```

Check while implementing (adjust to the real names, do not invent new APIs):
`useSettingsDialog` export name in `components/settings-dialog.tsx`; `command.trigger` signature in `context/command.tsx:453`; whether `project.name` exists on `LocalProject` (it is `Partial<Project>`); the border token class used elsewhere in `sidebar-shell.tsx`.

- [ ] **Step 4: Mount it.** In `layout-new-sidebar.tsx`:
  - Replace the body of `content(mobile)` with
    `<SessionSidebar sidebar={sidebar} mobile={mobile} onNewSession={(directory) => void tabs.newDraft({ server: server.key, directory })} />`.
  - Desktop `<nav>` width: `layout.sidebar.opened() ? side() : 0`; keep the resize handle; `panel()`/`RAIL_WIDTH` only remain if still referenced.
  - Delete the peek overlay `<div ...><Show when={sidebar.peekProject()}>...</Show></div>` block.
  - Update the comment above `ProjectSidebar` to describe the new behaviour.

- [ ] **Step 5: Verify.** `bun typecheck` clean; `bun run test:unit` passes.

---

### Task 4: Mod+1-9 open the Nth visible session

**Files:**
- Modify: `packages/app/src/pages/layout-new-sidebar.tsx`

**Interfaces:**
- Consumes: `visibleSessionOrder` (Task 2), `sortedRootSessions` from `pages/layout/helpers.ts`, `serverSync().child(worktree)`.

- [ ] **Step 1: Register commands** (the strip's `tab.N` commands are gone with Task 1, so `mod+N` is free):

```ts
const visible = createMemo(() =>
  visibleSessionOrder(
    layout.projects.list().map((project) => ({
      expanded: project.expanded,
      sessions: sortedRootSessions(serverSync().child(project.worktree)[0], sidebar.sortNow()),
    })),
  ),
)
command.register("sidebar-session-index", () =>
  visible()
    .slice(0, 9)
    .map((session, index) => ({
      id: `session.index.${index + 1}`,
      category: language.t("command.category.session"),
      title: session.title,
      keybind: `mod+${index + 1}`,
      hidden: true,
      onSelect: () => navigate(sessionHref(server.key, session.id)),
    })),
)
```

- [ ] **Step 2: Verify.** Typecheck and unit suite pass.

---

### Task 5: Model button never stays hidden

The new-session composer hides the model button while `model.loading` is true
(`packages/app/src/components/prompt-input-v2.tsx:584`, `<Show when={!props.loading}>`). `loading`
(`packages/app/src/pages/session/composer/session-composer-controls.ts:50-53`) is
`(local.agent.visible() && agentsQuery.isLoading) || providersQuery.isLoading || globalProvidersQuery.isLoading`.
TanStack v5 `isLoading` stays true forever if a `queryFn` never settles, and the catalog loaders
`loadProvidersQuery` (`packages/app/src/context/global-sync/bootstrap.ts:221-243`) and
`loadAgentsQuery` (`:259-271`) issue fetches with no timeout and ignore TanStack's `signal`. In the
desktop app one of these requests never answers, so the button never appears.

**Files:**
- Modify: `packages/app/src/context/global-sync/bootstrap.ts` (`loadProvidersQuery`, `loadAgentsQuery`)
- Modify: `packages/app/src/pages/session/composer/session-composer-controls.ts:50-53`
- Test: `packages/app/src/context/global-sync/bootstrap.test.ts`

**Interfaces:**
- Produces: catalog queries settle (success or error) within 15 s; `model.loading` is true only
  while neither provider catalog has data and one is still fetching.

- [ ] **Step 1: Failing test** in `bootstrap.test.ts`, following that file's existing imports and
  fixtures (read it first; use its real `loadProvidersQuery` signature and API stub shapes). Use a
  `QueryClient` with `retry: false`, stub every provider/model call as `() => new Promise(() => {})`,
  and assert `client.fetchQuery(loadProvidersQuery(..., 10))` rejects (the loaders gain an optional
  trailing `timeoutMs = CATALOG_TIMEOUT_MS` parameter so the test passes 10 ms). Add the same test for
  `loadAgentsQuery`.
- [ ] **Step 2:** run `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/context/global-sync/bootstrap.test.ts` → the new tests fail (hang/timeout).
- [ ] **Step 3: Implement.** In both loaders take `({ signal })` from the `queryFn` context and pass
  `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])` to every network call they make (legacy SDK
  calls accept `{ signal }` in their options; check the v2 client call signatures in the same file and
  pass the signal the way existing code in this package does). Name the constant
  `CATALOG_TIMEOUT_MS = 15_000` with a one-line comment: a request that never answers must not hide
  the composer's model control forever.
- [ ] **Step 4: Loading condition.** In `session-composer-controls.ts`:

```ts
// The model button only needs one provider catalog; agents never gate it.
loading: providersQuery.isLoading && globalProvidersQuery.isLoading,
```

  and remove `agentsQuery` from that file only if nothing else there uses it (it feeds
  `agents.loading`, so it stays).
- [ ] **Step 5:** run the bootstrap tests → pass; `bun typecheck` clean; `bun run test:unit` passes.

---

### Task 6: Permission hooks and auto-reviewer only for calls that would ask

Owner decision (2026-10-13): plugin `permission.ask` hooks and the LLM auto-reviewer run only for
tool calls the merged ruleset does not already allow. This reverts the part of commit `bda9eb16fb`
("gate approval shortcuts on plugin deny") that ran plugin hooks for rule-allowed calls: third-party
plugins written for the opencode contract (e.g. opencode-notify) treat `permission.ask` as "the user
is being prompted" and fire a desktop notification on every tool call. Plugin hooks must still run
before the approval-mode shortcuts (`staticApproval`, `auto`, `accept-edits`), so a plugin deny still
beats them for calls that would otherwise ask.

**Files:**
- Modify: `packages/flynncode/src/permission/index.ts` (`ask`, the `if (!needsAsk) return` near line 121
  and the `runPermissionAsk` block near lines 100-119)
- Modify: `packages/flynncode/src/session/tools.ts` (the `const reviewer = ...` block near lines 165-176)
- Test: `packages/flynncode/test/permission/permission-ask-hook.test.ts`, `packages/flynncode/test/session/tools.test.ts`

- [ ] **Step 1: Failing test** in `permission-ask-hook.test.ts`, reusing the file's existing deny-plugin
  fixture (`denyIt` and its recorded hook calls; read the file to find the real names):

```ts
denyIt.instance("a rule-allowed request never invokes plugin permission.ask hooks", () =>
  Effect.gen(function* () {
    // reset the fixture's recorded hook calls here, using its real variable
    const permission = yield* Permission.Service
    for (const approval of ["manual", "accept-edits", "auto"] as const)
      yield* permission.ask({ ...request([{ permission: "*", pattern: "*", action: "allow" }]), approval })
    // assert the fixture recorded zero permission.ask hook calls
    expect(yield* permission.list()).toHaveLength(0)
  }),
)
```

- [ ] **Step 2:** `cd packages/flynncode && bun test test/permission/permission-ask-hook.test.ts` → the new test fails with `DeniedError`.
- [ ] **Step 3: Implement (index.ts).** Move `if (!needsAsk) return` to directly after the pattern loop,
  before `hooksRunner.runPermissionAsk(...)`. Update the comment above the hook call to: plugin
  permission.ask hooks run only for requests that would ask, and before every approval-mode shortcut,
  so a plugin deny (or fail-closed verdict) wins in every mode.
- [ ] **Step 4: Update tests that encode the old contract.** `explicit config allow still visits the plugin
  deny gate` and the config-allowed `list`/`read`/`glob`/`grep` expectations around line 380-390 assert
  that rule-allowed calls are denied by a plugin. Change them to assert the call succeeds and the hook
  was not invoked, and rename the first to `explicit config allow skips plugin permission.ask hooks`.
  List every test you changed, with old and new assertion, in the report.
- [ ] **Step 5: Reviewer gate (tools.ts).** Only consult the auto-reviewer when some pattern is not
  allowed by the ruleset:

```ts
const allowed = req.patterns.every((pattern) => Permission.evaluate(req.permission, pattern, ruleset).action === "allow")
```

  and add `!allowed &&` to the `reviewer` condition. Check `Permission.evaluate` is exported under that
  name from `src/permission/index.ts` (line ~38) and imported the way `tools.ts` already imports
  `Permission`. Add a test in `test/session/tools.test.ts` following that file's existing auto-reviewer
  tests: a stub reviewer that records calls and returns "deny", approval "auto", a config-allowed tool
  call → succeeds and the reviewer recorded zero calls.
- [ ] **Step 6:** `bun test test/permission test/session/tools.test.ts` → all pass; `bun typecheck` clean.

---

### Task 7: Build and hand over

- [ ] **Step 1:** `cd packages/desktop && bun run build && bun run package:linux --linux deb`.
- [ ] **Step 2:** Copy `dist/flynncode-desktop-linux-amd64.deb` to `~/Downloads/`; confirm the packaged `app.asar` renderer bundle contains `sidebar-new-session`.
- [ ] **Step 3:** Owner installs with `sudo dpkg -i` and verifies: no tab strip; clicking sessions switches the view; collapse persists across restart; New session / Search / Open project / Settings work; Mod+1..9 jump.
