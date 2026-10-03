# V2 Session Header Terminal Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing terminal toggle button to the V2 session header so users can open the interactive side terminal panel from the UI.

**Architecture:** One component change (`SessionHeaderV2Actions` in `packages/app/src/components/session/session-header.tsx`): extend its state props with terminal fields populated from the existing `toggleTerminal` handler / layout view, and render an `IconButtonV2` mirroring the review button. One e2e regression test verifies the button opens/closes the panel.

**Tech Stack:** SolidJS, `@opencode-ai/ui` v2 components (`IconButtonV2`, `TooltipV2`, `KeybindV2`, legacy `Icon`), Playwright e2e with the `mockOpenCodeServer` helper.

**Spec:** `docs/superpowers/specs/2026-10-03-v2-header-terminal-toggle-design.md`

## Global Constraints

- Never hardcode user-visible English strings; use existing i18n key `command.terminal.toggle` (exists in all locales).
- Never restart the app or server process while debugging (per `packages/app/AGENTS.md`).
- Tests run from package dirs (`packages/app`), never repo root.
- Typecheck with `bun typecheck` from `packages/app`, never raw `tsc`.
- E2E hygiene per `packages/app/e2e/AGENTS.md`: no sleeps/timeouts, scoped locators, assert exact outcomes.
- Do not change English i18n text byte-for-byte; no new keys needed.
- Desktop main process and terminal I/O are untouched; placement/layout untouched.

---

### Task 1: Failing e2e test — V2 terminal toggle button opens the panel

**Files:**
- Create: `packages/app/e2e/regression/session-header-terminal-toggle.spec.ts`

**Interfaces:**
- Consumes: `mockOpenCodeServer` from `../utils/mock-server`, `expectSessionTitle` from `../utils/waits` (same as `terminal-hidden.spec.ts`).
- Produces: a test contract — header button located by `[data-action="session-terminal-toggle"]`, panel located by `#terminal-panel`. Task 2 adds the matching `data-action` attribute.

- [ ] **Step 1: Write the failing test**

Model it directly on `packages/app/e2e/regression/terminal-hidden.spec.ts` (same mocks), but drive the panel through the header button instead of the keybind:

```ts
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/HeaderTerminalToggleRegression"
const projectID = "proj_header_terminal_toggle_regression"
const sessionID = "ses_header_terminal_toggle_regression"
const title = "Header terminal toggle regression"

test("v2 header terminal button toggles the terminal panel", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "header-terminal-toggle-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "header-terminal-toggle-regression",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/pty*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        location: { directory, project: { id: projectID, directory } },
        data: {
          id: "pty_header_terminal_toggle",
          title: "Terminal 1",
          command: "cmd.exe",
          args: [],
          cwd: directory,
          status: "running",
          pid: 1,
        },
      }),
    }),
  )
  await page.route("**/api/pty/pty_header_terminal_toggle*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        location: { directory, project: { id: projectID, directory } },
        data: {
          id: "pty_header_terminal_toggle",
          title: "Terminal 1",
          command: "cmd.exe",
          args: [],
          cwd: directory,
          status: "running",
          pid: 1,
        },
      }),
    }),
  )
  await page.route("**/api/pty/pty_header_terminal_toggle/connect-token*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        location: { directory, project: { id: projectID, directory } },
        data: { ticket: "e2e-ticket", expires_in: 60 },
      }),
    }),
  )
  await page.routeWebSocket("**/api/pty/pty_header_terminal_toggle/connect", () => undefined)

  const button = page.locator('[data-action="session-terminal-toggle"]')
  const panel = page.locator("#terminal-panel")

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator('[data-component="terminal"]')).toHaveCount(0)

  await button.click()
  await expect(button).toHaveAttribute("aria-expanded", "true")
  await expect(panel).toHaveAttribute("aria-hidden", "false")
  await expect(page.locator('[data-component="terminal"]')).toBeVisible()

  await button.click()
  await expect(button).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator('[data-component="terminal"]')).toHaveCount(0)
})

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/app`): `bunx playwright test e2e/regression/session-header-terminal-toggle.spec.ts`
Expected: FAIL — the `[data-action="session-terminal-toggle"]` button never appears (`expect(button).toBeVisible()` times out).

- [ ] **Step 3: Commit**

```bash
git add packages/app/e2e/regression/session-header-terminal-toggle.spec.ts
git commit -m "test(app): add failing e2e for v2 header terminal toggle"
```

---

### Task 2: Implement the V2 header terminal toggle button

**Files:**
- Modify: `packages/app/src/components/session/session-header.tsx` (state type at lines 616-629, state memo at lines 298-311, `SessionHeaderV2Actions` render at lines 634-695)

**Interfaces:**
- Consumes: `toggleTerminal` handler (already defined at line 271 in the same file), `view().terminal.opened()`, `command.keybindParts("terminal.toggle")`, `language.t("command.terminal.toggle")`, `IconButtonV2` / `TooltipV2` / `KeybindV2` / `Icon` (all already imported).
- Produces: `SessionHeaderV2ActionsState` gains `terminalLabel: string`, `terminalKeybind: string[]`, `terminalOpened: boolean`, `onTerminalToggle: () => void`. Rendered button carries `data-action="session-terminal-toggle"` (the test contract from Task 1).

- [ ] **Step 1: Extend `SessionHeaderV2ActionsState` and populate it**

In `session-header.tsx`, add to the type (line 616):

```ts
type SessionHeaderV2ActionsState = {
  statusVisible: boolean
  statusLabel: string
  terminalLabel: string
  terminalKeybind: string[]
  terminalOpened: boolean
  onTerminalToggle: () => void
  reviewLabel: string
  reviewKeybind: string[]
  reviewVisible: boolean
  reviewOpened: boolean
  onReviewToggle: () => void
  tasksLabel: string
  tasksOpened: boolean
  onTasksToggle: () => void
  handoffLabel: string
  onHandoff: () => void
}
```

In `v2ActionsState` (line 298), insert after `statusLabel`:

```ts
    terminalLabel: language.t("command.terminal.toggle"),
    terminalKeybind: command.keybindParts("terminal.toggle"),
    terminalOpened: view().terminal.opened(),
    onTerminalToggle: toggleTerminal,
```

- [ ] **Step 2: Render the terminal button in `SessionHeaderV2Actions`**

Inside `SessionHeaderV2Actions` (`session-header.tsx:631`), inside the `<div class="flex items-center gap-2">` and **before** the review `<TooltipV2>` block (line 641), add:

```tsx
        <TooltipV2 class="shrink-0" placement="bottom" value={
          <>
            {props.state.terminalLabel}
            <Show when={props.state.terminalKeybind.length > 0}>
              <KeybindV2 keys={props.state.terminalKeybind} variant="neutral" />
            </Show>
          </>
        }>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            class="!w-9 shrink-0"
            data-action="session-terminal-toggle"
            state={props.state.terminalOpened ? "pressed" : undefined}
            onClick={props.state.onTerminalToggle}
            aria-label={props.state.terminalLabel}
            aria-expanded={props.state.terminalOpened}
            aria-controls="terminal-panel"
            icon={<Icon name={props.state.terminalOpened ? "terminal-active" : "terminal"} />}
          />
        </TooltipV2>
```

Notes:
- `Icon` here is the legacy icon set (imported at line 4); it defines `terminal` and `terminal-active` glyphs. This mirrors the tasks button, which also uses legacy `Icon name="checklist"`.
- `aria-controls="terminal-panel"` matches the `id` on the `TerminalPanelV2` aside element.
- `toggleTerminal` (line 271) already toggles the panel and focuses the active terminal after opening — reuse it; do not duplicate its logic.

- [ ] **Step 3: Run the failing test to verify it passes**

Run (from `packages/app`): `bunx playwright test e2e/regression/session-header-terminal-toggle.spec.ts`
Expected: PASS

- [ ] **Step 4: Run the existing terminal regression tests**

Run (from `packages/app`): `bunx playwright test e2e/regression/terminal-hidden.spec.ts e2e/regression/terminal-tab-switch.spec.ts e2e/regression/review-terminal-stacked.spec.ts`
Expected: all PASS — the new button must not break keybind-driven toggle or panel placement behavior.

- [ ] **Step 5: Typecheck**

Run (from `packages/app`): `bun typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/components/session/session-header.tsx
git commit -m "feat(app): add terminal toggle to v2 session header"
```

---

### Task 3: Manual desktop verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: running Flynncode desktop app (do not restart it; per `packages/app/AGENTS.md` verify against the existing dev servers instead if the desktop build cannot pick up changes).

- [ ] **Step 1: Verify in the app UI**

Open `http://localhost:4444` (app dev server against backend `http://localhost:4096` per `packages/app/AGENTS.md`). Confirm:
- A terminal icon button appears in the session header among the status/review/tasks/handoff actions.
- Clicking it opens the side terminal panel; clicking again closes it.
- The panel accepts clicks and keyboard input; typed commands execute.
- The button shows a pressed state while the panel is open, and the tooltip shows the toggle keybind (`ctrl+\``).