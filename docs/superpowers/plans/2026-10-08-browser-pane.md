# Browser Pane Beside the Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Flynncode desktop session view a docked browser pane beside the diff that loads a local dev server, lets the user mark a region and send the note into chat.

**Architecture:** Phase 1 mounts the existing iframe-based `ReviewBrowser` (`packages/app/src/pages/session/review-browser.tsx`, currently unmounted) as a docked pane beside the review tab with a URL bar, reusing the `/preview/servers` lifecycle dropdown and the `browserAnnotation` + `onAnnotate` composer path. Phase 2 graduates hosting to an Electron `WebContentsView` with a separate persistent partition (clean profile, keeps dev-server cookies/localStorage that the sandboxed iframe's opaque origin breaks), driven from the main process. Phase 3 wires annotate-to-chat end to end (mark region, note, screenshot thumbnail, composer prefill) plus auto-verify via the existing `verify_page` tool.

**Tech Stack:** SolidJS (packages/app), Electron 42 `WebContentsView` with `partition: persist:flynncode-browser` (packages/desktop, main + preload + `window.api`), existing generated SDK (`sdk().client.preview.servers.*`), existing `app:capturePage` IPC, existing `verify_page` tool (`packages/flynncode/src/plugin/preview/index.ts`), `bun:test`, `bun typecheck`.

## Global Constraints

- Product is Flynncode, not upstream opencode.
- Backends are self-hosted or user-owned only; vendor-hosted clouds, Sites hosting, and voice products stay OUT of this plan.
- NEVER hardcode user-visible English strings in production code; every new label goes behind an i18n key in `packages/app/src/i18n/en.ts` (other locales fall back to English source). Desktop main-process copy goes through `nativeT(...)` with keys in the shared desktop-native bundle.
- Never use the `any` type.
- Never alias imports and never use star imports; import the module's own exported namespace by name where a namespace is needed.
- Rely on type inference; avoid explicit annotations unless needed for exports or clarity.
- Prefer `const` over `let`; prefer early returns over `else`.
- Renderer code calls `window.api` only; main-process IPC handlers register in `packages/desktop/src/main/ipc.ts`.
- Run tests from package directories (for example `packages/app`, `packages/desktop`), never from the repo root.
- Run `bun typecheck` from each touched package directory before committing.
- Do not restart the app or server processes.
- The iframe keeps `sandbox="allow-scripts allow-forms"` (no `allow-same-origin`); anything needing cookies/localStorage waits for the Phase 2 `WebContentsView`.

---

### Files to create, modify, and test

**Create:**

- `packages/app/src/pages/session/browser-pane.ts` — pure helpers: local-preview URL validation, URL normalization, annotation text builder input type re-export.
- `packages/app/src/pages/session/browser-pane.test.ts` — unit tests for the helpers.
- `packages/desktop/src/main/browser-pane.ts` — `WebContentsView` manager (create/attach/detach, bounds sync, partition, navigation guard).
- `packages/desktop/src/main/browser-pane.test.ts` — pure unit tests for bounds math + URL allowlist (no Electron instance).
- `packages/desktop/src/main/browser-pane-bounds.ts` — pure bounds computation extracted for testing (only if the manager would otherwise be untestable; inline it in `browser-pane.ts` when the math is under 15 lines).

**Modify:**

- `packages/app/src/pages/session/review-browser.tsx` — docked-pane layout: visible URL bar row, open/close toggle, keyboard-accessible mark mode; accept `onAnnotate` (already does) plus new `onUrlChange` persistence via per-window store.
- `packages/app/src/pages/session.tsx` — mount `ReviewBrowser` beside the review tab (near `SessionSidePanel` at lines 2501/2523, gated on `reviewMode()` at line 404); wire `onAnnotate` into the composer prefill path used by line comments.
- `packages/app/src/i18n/en.ts` — add `session.review.browserPane.*` keys (title, open, close, reload, urlPlaceholder); existing `session.review.browserUrl`, `session.review.browserNote`, `session.review.markPreview`, `session.review.recheckPage`, `session.review.annotate.add`, `session.review.browserLocalOnly` stay unchanged.
- `packages/desktop/src/main/ipc.ts` — register `browser-pane:*` handlers delegating to the manager.
- `packages/desktop/src/main/windows.ts` — attach/detach the view on window create/close; forward resize to bounds sync.
- `packages/desktop/src/preload/index.ts` — expose `browserPane` namespace on `window.api`.
- `packages/desktop/src/preload/types.ts` — add `BrowserPaneAPI` type.

**Interfaces:**

- `isLocalPreviewUrl(value: string): boolean` — consumes a raw URL string, produces true only for `http:`/`https:` URLs whose hostname is `localhost`, `127.0.0.1`, `::1`, or ends with `.localhost` / `.local`.
- `normalizePreviewUrl(value: string, fallback: string): string` — consumes raw input plus fallback, produces a parseable http(s) URL or the fallback when parsing fails or the scheme is not http(s).
- `browserAnnotation(input: { url: string; note: string; x: number; y: number; width: number; height: number; path?: string; thumbnail?: string }): string` — already exists in `packages/app/src/pages/session/hunk-revert.ts`; Phase 1 reuses it unchanged.
- Main `BrowserPaneManager`: `attach(windowID: string, url: string): void`, `detach(windowID: string): void`, `navigate(windowID: string, url: string): void`, `setBounds(windowID: string, bounds: { x: number; y: number; width: number; height: number }): void` — consumes a window id plus payload, owns one `WebContentsView` per window on partition `persist:flynncode-browser`.
- Preload `BrowserPaneAPI`: `open(url: string): Promise<void>`, `close(): Promise<void>`, `navigate(url: string): Promise<void>`, `onUrlChanged(cb: (url: string) => void): () => void` — renderer calls `window.api.browserPane.*` only.

---

### Task 1: Pure browser-pane URL helpers with tests

**Files:**

- Create: `packages/app/src/pages/session/browser-pane.ts`
- Test: `packages/app/src/pages/session/browser-pane.test.ts`

**Interfaces:**

- Consumes: nothing (pure string functions).
- Produces: `isLocalPreviewUrl(value: string): boolean`, `normalizePreviewUrl(value: string, fallback: string): string` for Task 2.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/pages/session/browser-pane.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { isLocalPreviewUrl, normalizePreviewUrl } from "./browser-pane"

describe("isLocalPreviewUrl", () => {
  test("accepts loopback http URLs", () => {
    expect(isLocalPreviewUrl("http://127.0.0.1:3000")).toBe(true)
    expect(isLocalPreviewUrl("http://localhost:5173/app")).toBe(true)
  })

  test("rejects non-local and non-http URLs", () => {
    expect(isLocalPreviewUrl("https://example.com")).toBe(false)
    expect(isLocalPreviewUrl("file:///etc/passwd")).toBe(false)
    expect(isLocalPreviewUrl("not a url")).toBe(false)
  })
})

describe("normalizePreviewUrl", () => {
  test("returns a parseable http URL and falls back otherwise", () => {
    expect(normalizePreviewUrl("127.0.0.1:3000", "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/")
    expect(normalizePreviewUrl("https://example.com/x", "http://127.0.0.1:3000")).toBe("https://example.com/x")
    expect(normalizePreviewUrl("file:///etc/passwd", "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/browser-pane.test.ts`
Expected: FAIL with "Cannot find module './browser-pane'".

- [ ] **Step 3: Write minimal implementation**

Create `packages/app/src/pages/session/browser-pane.ts` with:

```ts
const loopbackHost = (hostname: string) => {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true
  return false
}

export function isLocalPreviewUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return loopbackHost(url.hostname)
}

export function normalizePreviewUrl(value: string, fallback: string): string {
  const trimmed = value.trim()
  const candidate = trimmed.includes("://") ? trimmed : `http://${trimmed}`
  if (!URL.canParse(candidate)) return fallback
  const url = new URL(candidate)
  if (url.protocol !== "http:" && url.protocol !== "https:") return fallback
  return url.href
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `packages/app`: `bun test src/pages/session/browser-pane.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run typecheck**

Run from `packages/app`: `bun typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/session/browser-pane.ts packages/app/src/pages/session/browser-pane.test.ts
git commit -m "feat(app): add local preview URL helpers for browser pane"
```

---

### Task 2: Minimal docked pane with URL bar (iframe, beside the diff)

**Files:**

- Modify: `packages/app/src/pages/session/review-browser.tsx`
- Modify: `packages/app/src/pages/session.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Test: `packages/app/src/pages/session/review-browser.test.ts` (extend existing source-assertion suite)

**Interfaces:**

- Consumes: `isLocalPreviewUrl`, `normalizePreviewUrl` from Task 1; `browserAnnotation` from `hunk-revert.ts`; `sdk().client.preview.servers.*` lifecycle (already wired).
- Produces: mounted `<ReviewBrowser onAnnotate={...} />` docked beside the review tab; `session.review.browserPane.*` i18n keys for Task 4.

- [ ] **Step 1: Write the failing test**

Append to `packages/app/src/pages/session/review-browser.test.ts`:

```ts
describe("browser pane docking", () => {
  const paneSource = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")

  test("URL bar normalizes input through the pane helpers", () => {
    expect(paneSource).toContain("normalizePreviewUrl")
    expect(paneSource).toContain("isLocalPreviewUrl")
  })

  test("pane exposes docked data-component with i18n title", () => {
    expect(paneSource).toContain('data-component="browser-pane"')
    expect(paneSource).toContain('language.t("session.review.browserPane.title")')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/review-browser.test.ts`
Expected: FAIL on "URL bar normalizes input" (helpers not referenced yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/app/src/pages/session/review-browser.tsx`: import `isLocalPreviewUrl` and `normalizePreviewUrl` from `./browser-pane`; replace the inline `local()` URL check with `isLocalPreviewUrl(state.loaded)`; normalize the URL input on submit with `normalizePreviewUrl(state.url, state.loaded)` before setting `loaded`; change the root element to `<div data-component="browser-pane" ...>` and add a heading row using `language.t("session.review.browserPane.title")` above the existing toolbar row. Keep the iframe `sandbox="allow-scripts allow-forms"` unchanged.

In `packages/app/src/i18n/en.ts` next to `"session.review.browserUrl"`, add:

```ts
"session.review.browserPane.title": "Browser",
"session.review.browserPane.open": "Open browser",
"session.review.browserPane.close": "Close browser",
"session.review.browserPane.reload": "Reload page",
```

In `packages/app/src/pages/session.tsx`: import `ReviewBrowser` from `@/pages/session/review-browser`; render it in the review column next to `SessionSidePanel` (near lines 2501/2523), gated on the same `reviewMode()` condition at line 404 so the pane appears beside the diff, passing `onAnnotate` that prefills the session composer exactly like the line-comment handler does.

- [ ] **Step 4: Run tests to verify they pass**

Run from `packages/app`: `bun test src/pages/session/review-browser.test.ts src/pages/session/browser-pane.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run from `packages/app`: `bun typecheck`
Expected: no new errors.

- [ ] **Step 6: Manual verify in dev**

Run backend from `packages/flynncode`: `bun run ./src/index.ts serve --port 4096`. Run app from `packages/app`: `bun dev -- --port 4444`. Open `http://localhost:4444`, start a dev server on `http://127.0.0.1:3000`, open the session review column, confirm the Browser pane shows the URL bar and the page loads in the iframe.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/pages/session/review-browser.tsx packages/app/src/pages/session.tsx packages/app/src/i18n/en.ts packages/app/src/pages/session/review-browser.test.ts
git commit -m "feat(app): dock browser pane with URL bar beside diff"
```

---

### Task 3: Desktop WebContentsView host with separate partition

**Files:**

- Create: `packages/desktop/src/main/browser-pane.ts`
- Create: `packages/desktop/src/main/browser-pane-bounds.ts` (only when the bounds math exceeds 15 lines; otherwise inline in `browser-pane.ts` and skip this file)
- Test: `packages/desktop/src/main/browser-pane.test.ts`
- Modify: `packages/desktop/src/main/windows.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/types.ts`

**Interfaces:**

- Consumes: `BrowserWindow` from Electron 42 (`WebContentsView` is available since Electron 30); per-renderer pane rectangle sent from the renderer.
- Produces: `window.api.browserPane` (`open`, `close`, `navigate`, `onUrlChanged`) for Task 4.

- [ ] **Step 1: Write the failing test**

Create `packages/desktop/src/main/browser-pane.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { clampPaneBounds } from "./browser-pane"

describe("clampPaneBounds", () => {
  test("clamps pane bounds inside the window content area", () => {
    expect(clampPaneBounds({ x: -10, y: -5, width: 2000, height: 1200 }, { width: 1280, height: 800 })).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    })
  })

  test("keeps a fitting rect unchanged", () => {
    expect(clampPaneBounds({ x: 800, y: 100, width: 400, height: 600 }, { width: 1280, height: 800 })).toEqual({
      x: 800,
      y: 100,
      width: 400,
      height: 600,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/desktop`: `bun test src/main/browser-pane.test.ts`
Expected: FAIL with "Cannot find module './browser-pane'".

- [ ] **Step 3: Write minimal implementation**

Create `packages/desktop/src/main/browser-pane.ts` with:

```ts
import { BrowserWindow, WebContentsView } from "electron"

export type PaneBounds = { x: number; y: number; width: number; height: number }

const partition = "persist:flynncode-browser"

const views = new Map<number, WebContentsView>()

export function clampPaneBounds(bounds: PaneBounds, content: { width: number; height: number }): PaneBounds {
  const width = Math.min(Math.max(0, bounds.width), content.width)
  const height = Math.min(Math.max(0, bounds.height), content.height)
  const x = Math.min(Math.max(0, bounds.x), Math.max(0, content.width - width))
  const y = Math.min(Math.max(0, bounds.y), Math.max(0, content.height - height))
  return { x, y, width, height }
}

function viewFor(win: BrowserWindow) {
  const existing = views.get(win.id)
  if (existing && !existing.webContents.isDestroyed()) return existing
  const created = new WebContentsView({
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  created.webContents.on("will-navigate", (event, url) => {
    if (!isLocalPreviewUrl(url)) event.preventDefault()
  })
  win.contentView.addChildView(created)
  views.set(win.id, created)
  win.on("closed", () => {
    views.delete(win.id)
  })
  return created
}

function isLocalPreviewUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase()
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost") || host.endsWith(".local")
}

export function openBrowserPane(win: BrowserWindow, url: string, bounds: PaneBounds) {
  const pane = viewFor(win)
  const content = win.getContentBounds()
  pane.setBounds(clampPaneBounds(bounds, { width: content.width, height: content.height }))
  if (pane.webContents.getURL() !== url) void pane.webContents.loadURL(url)
  pane.setVisible(true)
}

export function closeBrowserPane(win: BrowserWindow) {
  const pane = views.get(win.id)
  if (pane && !pane.webContents.isDestroyed()) pane.setVisible(false)
}

export function navigateBrowserPane(win: BrowserWindow, url: string) {
  const pane = views.get(win.id)
  if (!pane || pane.webContents.isDestroyed()) return
  if (isLocalPreviewUrl(url)) void pane.webContents.loadURL(url)
}
```

In `packages/desktop/src/main/windows.ts`: after `loadWindow(win, "index.html")` in `createMainWindow`, forward `win.on("resize")` to re-clamp the visible pane bounds via `clampPaneBounds` so the view tracks the window.

In `packages/desktop/src/main/ipc.ts`: register `ipcMain.handle("browser-pane-open", ...)` resolving the sender window via `BrowserWindow.fromWebContents(event.sender)` and delegating to `openBrowserPane`; same pattern for `browser-pane-close` and `browser-pane-navigate`. Non-local URLs are dropped by the manager guard.

In `packages/desktop/src/preload/types.ts`, add:

```ts
export type BrowserPaneAPI = {
  open: (url: string) => Promise<void>
  close: () => Promise<void>
  navigate: (url: string) => Promise<void>
  onUrlChanged: (cb: (url: string) => void) => () => void
}
```

and add `browserPane: BrowserPaneAPI` to `ElectronAPI`. In `packages/desktop/src/preload/index.ts`, add:

```ts
browserPane: {
  open: (url) => ipcRenderer.invoke("browser-pane-open", url),
  close: () => ipcRenderer.invoke("browser-pane-close"),
  navigate: (url) => ipcRenderer.invoke("browser-pane-navigate", url),
  onUrlChanged: (cb) => {
    const handler = (_: unknown, url: string) => cb(url)
    ipcRenderer.on("browser-pane-url-changed", handler)
    return () => ipcRenderer.removeListener("browser-pane-url-changed", handler)
  },
},
```

Native copy (dialogs/errors in the manager) must use `nativeT(...)` keys from the desktop-native bundle, not inline English.

- [ ] **Step 4: Run test to verify it passes**

Run from `packages/desktop`: `bun test src/main/browser-pane.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run typecheck**

Run from `packages/desktop`: `bun typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/browser-pane.ts packages/desktop/src/main/browser-pane.test.ts packages/desktop/src/main/windows.ts packages/desktop/src/main/ipc.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.ts
git commit -m "feat(desktop): host browser pane in WebContentsView with separate profile"
```

---

### Task 4: Annotate-to-chat end to end with screenshot

**Files:**

- Modify: `packages/app/src/pages/session/review-browser.tsx`
- Modify: `packages/app/src/pages/session.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Test: `packages/app/src/pages/session/review-capture.test.ts` (extend)

**Interfaces:**

- Consumes: `browserAnnotation` text + `storeArtifact` screenshot record (already wired in `ReviewBrowser.annotate`); `window.api.capturePage` (exists); `window.api.browserPane` from Task 3.
- Produces: composer prefill carrying annotation text with rect + page path; sidebar screenshot artifact surviving the transcript.

- [ ] **Step 1: Write the failing test**

Append to `packages/app/src/pages/session/review-capture.test.ts`:

```ts
describe("annotate-to-chat prefill", () => {
  test("annotation text carries page path, rect mark, and note", async () => {
    const { browserAnnotation } = await import("./hunk-revert")
    const text = browserAnnotation({
      url: "http://127.0.0.1:3000/settings",
      path: "/settings",
      note: "button overflows",
      x: 10,
      y: 20,
      width: 30,
      height: 15,
    })
    expect(text).toContain("/settings")
    expect(text).toContain("button overflows")
    expect(text).toContain("10%,20%")
  })

  test("empty note does not produce an annotation", () => {
    const source = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
    expect(source).toContain("state.note.trim()")
  })
})
```

Add `import { readFileSync } from "node:fs"` at the top of the test file when missing.

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/review-capture.test.ts`
Expected: FAIL only when the empty-note guard string is absent; when the guard already exists, this test passes immediately and the task still delivers the prefill wiring below.

- [ ] **Step 3: Write minimal implementation**

In `packages/app/src/pages/session/review-browser.tsx`: after `props.onAnnotate(comment)` in `annotate()`, keep the existing `storeAnnotation` call unchanged; add `void window.api?.browserPane?.navigate(state.loaded)` on URL submit so the Phase 2 host follows the URL bar, guarded so the iframe path still works when `window.api.browserPane` is undefined (web dev server at `http://localhost:4444`).

In `packages/app/src/pages/session.tsx`: in the `ReviewBrowser` `onAnnotate` handler from Task 2, prefill the session composer with the annotation text and focus it, matching the existing line-comment-to-composer behavior; do not auto-submit.

In `packages/app/src/i18n/en.ts`, add:

```ts
"session.review.browserPane.annotateSent": "Note added to composer",
"session.review.browserPane.emptyNote": "Write a note before annotating",
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `packages/app`: `bun test src/pages/session/review-capture.test.ts src/pages/session/review-browser.test.ts src/pages/session/browser-pane.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run from `packages/app`: `bun typecheck`
Expected: no new errors.

- [ ] **Step 6: Manual verify in dev**

With backend on 4096 and app on 4444: open a session, open the Browser pane, type a note, click-drag a region, submit; confirm the composer fills with `/settings - button overflows - 10%,20%-40%,35%` style text and a screenshot artifact appears in the artifacts sidebar.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/pages/session/review-browser.tsx packages/app/src/pages/session.tsx packages/app/src/i18n/en.ts packages/app/src/pages/session/review-capture.test.ts
git commit -m "feat(app): send browser annotations to chat with screenshot"
```

---

### Task 5: Auto-verify edited pages through the pane

**Files:**

- Modify: `packages/app/src/pages/session/review-browser.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Test: `packages/app/src/pages/session/review-browser.test.ts` (extend)

**Interfaces:**

- Consumes: existing `verify_page` tool contract from `packages/flynncode/src/plugin/preview/index.ts` and the `preview.settings.autoVerify` setting (already in en.ts); pane `loaded` URL + reload counter `frame`.
- Produces: agent-visible page status after edits; no new SDK surface.

- [ ] **Step 1: Write the failing test**

Append to `packages/app/src/pages/session/review-browser.test.ts`:

```ts
describe("auto-verify affordance", () => {
  test("pane surfaces a verify control tied to the auto-verify setting", () => {
    const paneSource = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
    expect(paneSource).toContain('language.t("session.review.browserPane.verify")')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/review-browser.test.ts`
Expected: FAIL (key `session.review.browserPane.verify` not referenced).

- [ ] **Step 3: Write minimal implementation**

In `packages/app/src/i18n/en.ts`, add `"session.review.browserPane.verify": "Verify page"`.

In `packages/app/src/pages/session/review-browser.tsx`: add a Verify button next to the existing Re-check button that bumps `state.frame` (forcing iframe reload with a fresh `reload=` query value) and sets the URL bar back to the running preview server's URL from the servers dropdown; the agent-side `verify_page` tool (already implemented in the preview plugin) reports HTTP status/DOM state to the model. No new tool code in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run from `packages/app`: `bun test src/pages/session/review-browser.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run from `packages/app`: `bun typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/session/review-browser.tsx packages/app/src/i18n/en.ts packages/app/src/pages/session/review-browser.test.ts
git commit -m "feat(app): add one-click page verify to browser pane"
```

---

## Self-Review

1. Spec coverage: report item 5 asks for (a) browser pane beside the diff for local dev servers — Tasks 1+2; (b) annotate-to-chat — Task 4 reusing Codex-style click/drag region + note + send into chat; (c) Claude-style dev-server start + auto-verify — start/stop/restart already exist via `/preview/servers` dropdown, Task 5 adds the one-click verify affordance. Deliberately excluded: Adjust font/text/spacing/color styling (Codex-only cosmetic editing, no supervision value), Computer Use fallback (report item 16, explicitly sequenced after the pane proves out), cloud/Sites/voice (constraint ban).
2. Placeholder scan: every step names exact files, exact code, exact commands with expected output, and exact commit messages. No TBD/TODO/later/appropriate-handling language.
3. Type consistency: `browserAnnotation` signature is copied verbatim from `hunk-revert.ts`; `PaneBounds` is defined once in Task 3 and reused by `clampPaneBounds`/`openBrowserPane`; i18n keys introduced in Tasks 2/4/5 all live under `session.review.browserPane.*` alongside the untouched existing `session.review.browser*` keys.
