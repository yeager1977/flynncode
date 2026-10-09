# Quick-Entry Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the existing desktop quick-entry path (global shortcut → `quick-entry` IPC → inline composer → `opencode://new-session` deep link) so it works reliably on macOS/Windows/Linux without a new popup window.

**Architecture:** Keep the single-main-window design: extract shortcut registration into a tested main-process module that shows and focuses the last window before sending `quick-entry`; harden the renderer listener and finish the inline composer in `layout.tsx` (focus, Escape, empty-project state) routing into a new session in the current directory via the existing deep-link handler.

**Tech Stack:** Electron 42 `globalShortcut`, `BrowserWindow`, SolidJS (`createStore` state in `layout.tsx`), existing `opencode://new-session` deep-link pipeline, typed i18n (`language.t` / `t` in app, `nativeT` in main), Bun + TypeScript, `bun test` / existing vitest files.

## Global Constraints

- Backends self-hosted or user-owned only; vendor-hosted clouds, Sites hosting, and voice products stay OUT.
- UI copy via i18n keys (en only); NEVER hardcode user-visible English strings in production code.
- No `any` type in new or edited code.
- No star imports and no aliased imports (`import { foo as bar }` forbidden).
- Renderer process must only call `window.api` from `src/preload`; main process registers IPC handlers in `src/main/ipc.ts`.
- Follow `import { Project } from "@opencode-ai/core/project"` namespace style when a namespace value is needed.
- Prefer `const` over `let`; early returns instead of `else`; dot notation over destructuring; `Bun.file()` for file reads.
- Run `bun typecheck` from package directories (e.g. `packages/desktop`, `packages/app`), never `tsc` directly.
- Tests run from package dirs (e.g. `packages/desktop`, `packages/app`), never repo root.
- Use conventional commits (`feat(desktop): ...`, `fix(app): ...`); default branch `dev`; short hyphenated branch names (max three words, no slashes).

---

## Current State (verified on `dev`, 2026-10-08)

- `packages/desktop/src/main/index.ts:260-266` registers `CommandOrControl+Shift+Space`, shows and focuses `getLastFocusedWindow()`, calls `sendQuickEntry(win)`. Missing: no extraction, no unregister on quit, no registration-failure logging, no Linux/Wayland fallback note.
- `packages/desktop/src/main/ipc.ts:349-351` defines `sendQuickEntry` (`win.webContents.send("quick-entry")`). Wiring is complete; no change needed except reuse.
- `packages/desktop/src/preload/index.ts:104-108` and `types.ts:102` expose `onQuickEntry`. Wiring is complete; no change needed.
- `packages/desktop/src/renderer/index.tsx:85,344` re-dispatches as `opencode:quick-entry` window event. Wiring is complete; needs only a named-constant cleanup.
- `packages/app/src/pages/layout.tsx:147,1293-1296,2283-2309` listens for `opencode:quick-entry`, requires `currentDir()` (route dir), shows an inline `<form data-component="quick-entry">` that synthesizes `opencode://new-session?directory=...&prompt=...` into `handleDeepLinks` (`layout.tsx:1263-1281`), which opens the project, sets a session handoff, and navigates to `/{slug}/session?prompt=...`. Missing: input never focuses reliably, no Escape to dismiss, no empty-project state (silently does nothing when `currentDir()` is empty), composer reuses `dispatch.placeholder` / `dispatch.send` keys instead of quick-entry copy, no tests for the submit path.
- `packages/app/src/pages/layout/deep-links.ts:22-37` already parses/builds `new-session` links with optional `prompt`; tests exist in `helpers.test.ts:81-99`.
- Decision: NO popup `BrowserWindow`, NO tray icon, NO macOS double-tap-Option detector, NO screenshot/window attach in this workstream. Those are explicitly out of scope; the global shortcut focusing the main window plus the inline composer closes the loop for WS6 at small effort.

---

### Task 1: Extract quick-entry shortcut module in main process

**Files:**
- Create: `packages/desktop/src/main/quick-entry.ts`
- Create: `packages/desktop/src/main/quick-entry.test.ts`
- Modify: `packages/desktop/src/main/index.ts` (replace inline `globalShortcut.register` block)

**Interfaces:**
- Consumes: `getLastFocusedWindow` from `./windows`, `sendQuickEntry` from `./ipc`, Electron `app`, `globalShortcut`, `BrowserWindow` types.
- Produces: `registerQuickEntryShortcut() => boolean` (true when registration succeeded), `unregisterQuickEntryShortcut() => void`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(join(import.meta.dir, "quick-entry.ts"), "utf8")

describe("quick-entry shortcut module", () => {
  test("exports register and unregister functions", () => {
    expect(source).toContain("export function registerQuickEntryShortcut")
    expect(source).toContain("export function unregisterQuickEntryShortcut")
  })

  test("uses the existing accelerator and sendQuickEntry", () => {
    expect(source).toContain("CommandOrControl+Shift+Space")
    expect(source).toContain("sendQuickEntry")
  })

  test("unregisters on demand", () => {
    expect(source).toContain("globalShortcut.unregister")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/main/quick-entry.test.ts` (workdir `packages/desktop`)
Expected: FAIL with "No such file or directory" for `quick-entry.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { app, globalShortcut } from "electron"
import { sendQuickEntry } from "./ipc"
import { getLastFocusedWindow } from "./windows"

export const QUICK_ENTRY_ACCELERATOR = "CommandOrControl+Shift+Space"

export function registerQuickEntryShortcut() {
  const registered = globalShortcut.register(QUICK_ENTRY_ACCELERATOR, () => {
    const win = getLastFocusedWindow()
    if (!win) return
    win.show()
    win.focus()
    sendQuickEntry(win)
  })
  app.once("will-quit", unregisterQuickEntryShortcut)
  return registered
}

export function unregisterQuickEntryShortcut() {
  globalShortcut.unregister(QUICK_ENTRY_ACCELERATOR)
}
```

Style notes: `QUICK_ENTRY_ACCELERATOR` is a genuine reuse boundary (used by the module and surfaced for settings/docs later), so the shared constant is justified. No `try`/`catch`: Electron's `register` returns boolean instead of throwing.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/main/quick-entry.test.ts` (workdir `packages/desktop`)
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `index.ts` and typecheck**

In `packages/desktop/src/main/index.ts`: delete the inline block at lines 260-266:

```ts
globalShortcut.register("CommandOrControl+Shift+Space", () => {
  const win = getLastFocusedWindow()
  if (!win) return
  win.show()
  win.focus()
  sendQuickEntry(win)
})
```

Replace with:

```ts
registerQuickEntryShortcut()
```

Update the import on line 9 from `import { app, BrowserWindow, globalShortcut } from "electron"` to `import { app, BrowserWindow } from "electron"`, change line 17 to import `registerQuickEntryShortcut` from `./quick-entry`, and remove `getLastFocusedWindow` and `sendQuickEntry` from their import lines only if unused elsewhere in the file (keep them if referenced by other code; check with grep before deleting).

Run: `bun typecheck` (workdir `packages/desktop`)
Expected: PASS with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/quick-entry.ts packages/desktop/src/main/quick-entry.test.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): extract quick-entry shortcut registration"
```

---

### Task 2: Name the renderer quick-entry event and keep dispatch behavior

**Files:**
- Modify: `packages/desktop/src/renderer/index.tsx:66-85,344`

**Interfaces:**
- Consumes: `window.api.onQuickEntry` from preload.
- Produces: `quickEntryEvent = "opencode:quick-entry"` constant reused by listener registration; identical runtime behavior (no new API).

- [ ] **Step 1: Edit `index.tsx`**

Replace line 66 (`const deepLinkEvent = "opencode:deep-link"`) region with both constants:

```ts
const deepLinkEvent = "opencode:deep-link"
const quickEntryEvent = "opencode:quick-entry"
```

Replace line 85:

```ts
const listenForQuickEntry = () => window.api.onQuickEntry(() => window.dispatchEvent(new CustomEvent("opencode:quick-entry")))
```

with:

```ts
const listenForQuickEntry = () => window.api.onQuickEntry(() => window.dispatchEvent(new CustomEvent(quickEntryEvent)))
```

No behavior change; this makes the event name greppable and prevents string drift between emitter and future tests.

- [ ] **Step 2: Typecheck**

Run: `bun typecheck` (workdir `packages/desktop`)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/renderer/index.tsx
git commit -m "refactor(desktop): name quick-entry renderer event"
```

---

### Task 3: Add quick-entry i18n keys (en only)

**Files:**
- Modify: `packages/app/src/i18n/en.ts` (add keys near `dispatch.placeholder` at line 963)
- Modify: `packages/desktop/src/renderer/i18n/en.ts` (no new keys needed; verify no native-menu copy is added)

**Interfaces:**
- Consumes: nothing.
- Produces: `quickEntry.placeholder`, `quickEntry.send`, `quickEntry.empty` keys consumed by Task 4.

- [ ] **Step 1: Add keys to `packages/app/src/i18n/en.ts`**

Insert after the `"dispatch.sendFailed"` entry:

```ts
"quickEntry.placeholder": "Type a prompt for the current project…",
"quickEntry.send": "Send",
"quickEntry.empty": "Open a project first, then use quick entry to start a session.",
```

Exact English is new product copy for this feature (not a migration), so byte-for-byte preservation rules do not apply; keep the ellipsis character `…` (U+2026) as written.

- [ ] **Step 2: Verify no other locale files are touched**

Run: `git status --short` (workdir repo root)
Expected: only `packages/app/src/i18n/en.ts` modified. All other locales fall back to English through the existing typed i18n layer; translators fill them later.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/i18n/en.ts
git commit -m "feat(app): add quick-entry composer copy keys"
```

---

### Task 4: Finish the inline quick-entry composer in `layout.tsx`

**Files:**
- Modify: `packages/app/src/pages/layout.tsx:147-161,1293-1296,2283-2309`
- Test: extend `packages/app/src/pages/layout/helpers.test.ts` (URL-builder coverage only; no DOM mocks)

**Interfaces:**
- Consumes: `quickEntry.*` i18n keys from Task 3, `collectNewSessionDeepLinks` / `parseNewSessionDeepLink` from `./layout/deep-links`, existing `handleDeepLinks`, `currentDir`, `setState`.
- Produces: composer that focuses on open, dismisses on Escape, submits prompt into a new session in the current directory, and shows an empty state when no project is open.

- [ ] **Step 1: Add a URL builder to `deep-links.ts` and test it first**

Append to `packages/app/src/pages/layout/deep-links.ts`:

```ts
export function buildNewSessionDeepLink(directory: string, prompt: string) {
  return `opencode://new-session?directory=${encodeURIComponent(directory)}&prompt=${encodeURIComponent(prompt)}`
}
```

Add to `packages/app/src/pages/layout/helpers.test.ts`:

```ts
import { buildNewSessionDeepLink } from "./deep-links"

test("builds new-session deep link with encoded prompt", () => {
  expect(buildNewSessionDeepLink("/tmp/demo", "hello world")).toEqual(
    "opencode://new-session?directory=%2Ftmp%2Fdemo&prompt=hello%20world",
  )
})
```

Run: `bun test src/pages/layout/helpers.test.ts` (workdir `packages/app`)
Expected: new test passes; existing 81-99 tests still pass.

- [ ] **Step 2: Update the quick-entry listener (Escape + empty state safe)**

Replace lines 1293-1296:

```ts
makeEventListener(window, "opencode:quick-entry", () => {
  if (!currentDir()) return
  setState("quickEntry", true)
})
```

with:

```ts
makeEventListener(window, "opencode:quick-entry", () => {
  setState("quickEntry", true)
})
```

The composer itself now handles the no-project case (Step 3) instead of silently ignoring the shortcut, so the shortcut always gives visible feedback.

- [ ] **Step 3: Replace the composer form**

Replace the `<Show when={state.quickEntry}>` block at lines 2283-2309 with:

```tsx
<Show when={state.quickEntry}>
  <form
    class="absolute inset-x-0 top-12 z-50 mx-auto flex w-[min(32rem,calc(100%-2rem))] gap-2 rounded-md border border-border-weak-base bg-background-base p-2"
    data-component="quick-entry"
    onSubmit={(event) => {
      event.preventDefault()
      const directory = currentDir()
      const prompt = state.quickEntryText.trim()
      if (!directory || !prompt) return
      handleDeepLinks([buildNewSessionDeepLink(directory, prompt)])
      setState({ quickEntry: false, quickEntryText: "" })
    }}
    onKeyDown={(event) => {
      if (event.key === "Escape") setState({ quickEntry: false, quickEntryText: "" })
    }}
  >
    <Show
      when={currentDir()}
      fallback={<p class="min-w-0 flex-1 px-2 py-1 text-14-regular">{language.t("quickEntry.empty")}</p>}
    >
      <input
        class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-2 py-1 text-14-regular"
        value={state.quickEntryText}
        ref={(el) => queueMicrotask(() => el.focus())}
        aria-label={language.t("quickEntry.placeholder")}
        placeholder={language.t("quickEntry.placeholder")}
        onInput={(event) => setState("quickEntryText", event.currentTarget.value)}
      />
      <Button type="submit" size="small">
        {language.t("quickEntry.send")}
      </Button>
    </Show>
  </form>
</Show>
```

Notes: `buildNewSessionDeepLink` must be imported from `./layout/deep-links` alongside `collectNewSessionDeepLinks` at the top of `layout.tsx`. `ref` with `queueMicrotask` focuses the input when the composer opens (SolidJS sets `ref` on mount; autofocus attribute alone is unreliable in the Electron renderer). `autofocus` attribute from the old markup is removed. `Button` is the existing import already used by the old form; do not add a new button component.

- [ ] **Step 4: Typecheck and run layout tests**

Run: `bun typecheck` (workdir `packages/app`)
Expected: PASS.

Run: `bun test src/pages/layout/helpers.test.ts` (workdir `packages/app`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/layout.tsx packages/app/src/pages/layout/deep-links.ts packages/app/src/pages/layout/helpers.test.ts
git commit -m "feat(app): finish quick-entry composer focus dismiss routing"
```

---

### Task 5: Manual verification and docs note

**Files:**
- Modify: none (verification only). Optional one-line note in the plan file itself if behavior differs.

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: verified shortcut behavior per platform.

- [ ] **Step 1: Start desktop dev and open a project**

Run: `bun dev` (workdir `packages/desktop`), open any project directory in the app.
Expected: main window opens on the project session list.

- [ ] **Step 2: Trigger quick entry from another app**

Press `Ctrl+Shift+Space` (Linux/Windows) or `Cmd+Shift+Space` (macOS) while a different app is focused.
Expected: Flynncode window shows and focuses, quick-entry composer appears at the top with the input focused.

- [ ] **Step 3: Submit a prompt**

Type `hello quick entry` and press Enter.
Expected: app navigates to a new session in the current project directory with `hello quick entry` as the initial prompt (same as pasting an `opencode://new-session` link today).

- [ ] **Step 4: Verify Escape and empty state**

Press the shortcut again, press Escape: composer closes. Navigate home (no project open), press the shortcut: composer shows the `quickEntry.empty` message instead of doing nothing.

- [ ] **Step 5: Record Wayland outcome**

On a Wayland session, if `Ctrl+Shift+Space` does nothing while another app is focused, record it as a known limitation (Electron `globalShortcut` does not support Wayland compositors; the in-app shortcut path still works when the window is focused). Do NOT add code in this task; file the follow-up for a portal-based listener.

---

## Self-Review

- Spec coverage: report item 7 asks for a global quick-entry composer on the existing deep-link path (Claude macOS double-tap-Option composer, Linux portal). Tasks 1-4 deliver the global-shortcut half on the existing path at small effort; double-tap-Option and X11/Wayland portal listeners are deliberately deferred (need native key-tap code and portal D-Bus work, each larger than this item's budget) and Task 5 records the Wayland gap.
- Placeholder scan: no TBD/TODO/later; every step names exact files, exact commands, exact copy, and expected outcomes.
- Type consistency: `registerQuickEntryShortcut() => boolean`, `buildNewSessionDeepLink(directory: string, prompt: string) => string`, and `quickEntry.*` keys are defined once and referenced identically in later tasks.

## Out of Scope (explicit)

- Dedicated popup `BrowserWindow`, tray icon, or menu-bar window (not needed; main-window focus + inline composer reuses all existing routing).
- macOS double-tap-Option detection (requires native Carbon/CGEventTap code outside Electron APIs).
- Linux X11/Wayland portal global listener (requires D-Bus portal work; Electron `globalShortcut` covers X11, not Wayland).
- Screenshot or window attach into the prompt (needs `desktopCapturer` + consent UX; separate workstream).
- Project picker inside the composer (empty state directs the user to open a project first).
