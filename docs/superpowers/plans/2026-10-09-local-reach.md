# Local Reach (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six Phase-2 "local reach" gaps: native-hosted browser pane with element-metadata annotation (item 5), quick-entry settings toggle + screenshot attach (item 7), Codex-style self-curating memories (item 11), multi-folder containment/listing/prompt-awareness fixes (item 13), per-agent sandbox mode override + isolation error fallback (item 14), and hook-parity gap fills (item 15).

**Architecture:** Gap-closing plan — Phase-2 research established that four of six items are already substantially implemented (`dev` history and this branch). Every task targets one verified gap with exact anchors from the research. The one large new surface is the Tier-2 native preview host (`WebContentsView`), scoped tightly behind a by-default-off config flag alongside the existing sandboxed-iframe pane (kept as fallback).

**Tech Stack:** Effect-TS v4, SolidJS, Electron main/preload, Bun test, Drizzle/SQLite.

## Global Constraints

- Branch: `codex-parity-build` (continues Phase 1; `dev` untouched until program end).
- Tests run from package dirs only (`packages/app`, `packages/desktop`, `packages/opencode`, `packages/core`), never repo root. App unit command pattern: `bun test --isolate --conditions=solid --preload ./happydom.ts <paths>`.
- Typecheck via `bun typecheck` from package dirs, never `tsc` directly.
- i18n: English source `packages/app/src/i18n/en.ts`; new keys registered in `packages/app/src/i18n/flynncode-fallback.ts`; never hardcode English; never mutate existing English strings.
- Generated SDK: run `bun run generate` from `packages/client` when HttpApi/schema surface changes; never edit `packages/sdk/js/src/generated*` or `src/v2/gen` by hand.
- V2 session-core rules (root AGENTS.md): `Location.Ref` stays the sole placement key; extras widen the filesystem boundary only, never placement; no bridging V1↔V2 orchestration; durable admission respected.
- Effect style: named service bindings, no nested service yields, no `any`, no `else`, prefer `const`; comments only for non-obvious constraints.
- Conventional commits `type(scope): summary`. Commits never on `dev`.
- Line anchors in this plan come from branch research at `d89cd4980f`; re-anchor by file/symbol names during execution.

---

### Task 1: Browser annotation carries a real image attachment [item 5, Tier 1]

**Files:**
- Modify: `packages/app/src/pages/session/review-browser.tsx` (`onAnnotate` payload, capture flow at ~L126–156)
- Modify: `packages/app/src/pages/session/v2/review-panel-v2.tsx` (~L372–383 annotation plumbing)
- Modify: `packages/app/src/pages/session/hunk-revert.ts` (`browserAnnotation` ~L30–46 — stop inlining the data URL into comment text)
- Modify: `packages/app/src/utils/prompt-state` consumers — `context/prompt-state.ts:36–43` (`ImageAttachmentPart`) insertion at the session wiring
- Test: `packages/app/src/pages/session/review-capture.test.ts`, `packages/app/src/pages/session/hunk-revert.test.ts` (extend)

**Interfaces:**
- Consumes: `window.api.capturePage(rect)` (desktop IPC, DIP-corrected, exists); `platform.draftStore.putBlob(blob)` (sha256 blob ids, `draft-store.ts:156–167`); `ImageAttachmentPart` shape (`context/prompt-state.ts:36–43`); storeArtifact for the sidebar artifact (`review-browser.tsx:142–156`, unchanged).
- Produces: `onAnnotate(input: { file: string; comment: string; rect: PercentRect; screenshot?: string })` — structured payload; the screenshot becomes a persisted blob + attachment part instead of a base64 string inside the comment text.

- [ ] **Step 1: Write failing source-contract + unit tests**

Extend `review-capture.test.ts`:

```ts
test("annotation payload is structured, not a base64 comment", () => {
  const source = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
  expect(source).toContain("onAnnotate({")            // structured payload call
  expect(source).toContain("screenshot: dataUrl")      // capture flows through the payload
})
```

Extend `hunk-revert.test.ts`:

```ts
test("browserAnnotation text omits the data url thumbnail", () => {
  const text = browserAnnotation({
    path: "preview", note: "fix the nav overlap", rect: { x: 10, y: 20, width: 40, height: 35 },
    thumbnail: "data:image/png;base64,AAAA",
  })
  expect(text).toBe("preview - fix the nav overlap - 10%,20%-40%,35%")
})
```

(The exact `browserAnnotation` input shape adapts to the current signature; the invariant is: data URLs never appear in the returned text.)

- [ ] **Step 2: Run tests to verify they fail**

From `packages/app`: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/session/review-capture.test.ts ./src/pages/session/hunk-revert.test.ts`
Expected: FAIL (payload currently string; text currently inlines thumbnails).

- [ ] **Step 3: Implement**

1. `review-browser.tsx`: change the `onAnnotate` prop type to the structured payload; pass `screenshot: dataUrl` from the existing `capturePage` result; keep `storeArtifact` unchanged.
2. `hunk-revert.ts` `browserAnnotation`: drop the thumbnail from the produced text (percent-rect + note only; keep a thumbnail parameter accepted-but-ignored or move it out of the text path per current call sites).
3. `review-panel-v2.tsx` annotation plumbing: after `addCommentToContext`, convert the screenshot when present — `const blob = await (await fetch(screenshot)).blob(); const id = await ctx.platform.draftStore.putBlob(blob)` then insert an `ImageAttachmentPart` via the prompt store's attachment insertion (`prompt.set([...parts, { type: "attachment", name: "browser-annotate.png", blobId: id }], cursor)` mirroring the clipboard-image flow in `prompt-input/attachments.ts:116–118`). Adapt field names to the actual `ImageAttachmentPart` shape.
4. Data URL size guard: if `fetch(dataUrl)` fails (non-desktop), degrade to the old text-inlined comment but keep it under the existing truncation — behavior must never hard-fail annotation.

- [ ] **Step 4: Run tests to verify they pass**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

`bun typecheck` from `packages/app`; then:

```bash
git add packages/app/src/pages/session/review-browser.tsx packages/app/src/pages/session/v2/review-panel-v2.tsx packages/app/src/pages/session/hunk-revert.ts packages/app/src/pages/session/hunk-revert.test.ts packages/app/src/pages/session/review-capture.test.ts
git commit -m "feat(app): send browser annotations with a real image attachment"
```

---

### Task 2: Point-mode annotation + auto-open on running preview [item 5, Tier 1]

**Files:**
- Modify: `packages/app/src/pages/session/review-browser.tsx` (mark overlay ~L100–110, ~L397–426; server state watch)
- Test: `packages/app/src/pages/session/review-browser.test.ts` (extend)

**Interfaces:**
- Consumes: existing region-select overlay (`marking/marked/x/y/width/height`, percent coords); `browserAnnotation` percent-only branch (`hunk-revert.ts:42` already supports click rects); `preview.servers.list` state (`preview.ts:38–46`, state literals running/stopped/starting/failed).
- Produces: (a) two-mode mark control (drag-rect | click-point, click → `width:0,height:0` rect at percentage); (b) pane auto-opens when any preview server transitions to `running`.

- [ ] **Step 1: Write failing tests**

Extend `review-browser.test.ts` (source-contract style, existing file):

```ts
test("mark control offers a point mode", () => {
  const source = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
  expect(source).toContain('data-action="mark-point"')
})
test("browser pane auto-opens on a running preview server", () => {
  const source = readFileSync(new URL("./v2/review-panel-v2.tsx", import.meta.url), "utf8")
  expect(source).toContain('setBrowserOpen(true)')
})
```

(If auto-open lands in `review-browser.tsx` instead of the panel, assert against that file — the invariant is the open call wired to the `running` state.)

- [ ] **Step 2: Run to verify failure** — from `packages/app`, same files; expected FAIL.

- [ ] **Step 3: Implement**

1. Add a mode toggle in the annotate affordance: drag mode = existing behavior; point mode = single pointerdown records `{x,y,width:0,height:0}` and completes the mark (pointer capture not needed). Percent coords only, matching the existing `browserAnnotation` branch.
2. Auto-open: in the pane component, watch the preview servers query (`sdk().client.preview.servers.list`) — `createEffect` sets `browserOpen(true)` when any entry reports `state === "running"` and the pane is closed. Do not auto-open on startup restore (respect the user's closed state for the same URL).
3. i18n: no new keys unless the mode toggle needs a label — reuse `session.review.markPreview` for drag; add `session.review.markPoint` if a distinct label/tooltip is required (register in `flynncode-fallback.ts`).

- [ ] **Step 4: Run tests to verify they pass** — same command; PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
git add packages/app/src/pages/session/review-browser.tsx packages/app/src/pages/session/review-browser.test.ts packages/app/src/pages/session/v2/review-panel-v2.tsx
git commit -m "feat(app): point-mode browser annotation and auto-open on running preview"
```

---

### Task 3: Native preview host with element inspection [item 5, Tier 2]

**Files:**
- Create: `packages/desktop/src/main/preview-host.ts` (+ `preview-host.test.ts`)
- Modify: `packages/desktop/src/main/ipc.ts` (register handles beside `app:capturePage` ~L203–212)
- Modify: `packages/desktop/src/preload/index.ts` + `packages/desktop/src/preload/types.ts` (typed accessors)
- Modify: `packages/app/src/app.tsx` (`Window.api` declaration ~L272–285 — optional members)
- Modify: `packages/app/src/pages/session/review-browser.tsx` (use native host when available + config flag on)
- Modify: `packages/opencode/src/config/preview.ts` (add `nativeHost?: boolean` per-server or global, tolerant, default `false`)
- Modify: `packages/app/src/components/settings-v2/preview.tsx` (+ payload) — toggle for the flag
- Test: `preview-host.test.ts` (new, injectable-deps style mirroring `muse-auth.test.ts`)

**Interfaces:**
- Consumes: Electron `WebContentsView` + `win.contentView.children` lookup primitives already coded in `desktop/src/main/computer-use.ts:11–42` (`paneFor` pattern — currently finds nothing because no view is ever created); `ipcMain.handle` pattern (self-contained handlers like `app:capturePage`, `ipc.ts:203–212`); `isLocalPreviewUrl` gate (`browser-pane.ts:1–13`); `desktop/src/main/external-url.ts:3–8` http/https gating.
- Produces: `window.api.previewHost = { attach(url): Promise<void>, setBounds(rect): Promise<void>, detach(): Promise<void>, capture(): Promise<string>, inspect(rect?): Promise<{ tag, id?, classes?, text?, rect } | null> }` — the element payload that unblocks real element metadata; the existing iframe stays the fallback when the API is missing or the flag is off.

- [ ] **Step 1: Write the failing main-process test**

`packages/desktop/src/main/preview-host.test.ts` — pure-function coverage, no Electron (mirror `computer-use.ts`'s factored-helper style):

```ts
test("preview host accepts only local preview urls", () => {
  expect(isHostable("http://127.0.0.1:3000/app")).toBe(true)
  expect(isHostable("https://example.com")).toBe(false)
  expect(isHostable("file:///etc/passwd")).toBe(false)
})
test("element payload is clamped and sanitized", () => {
  const el = sanitizeElement({ tag: "BUTTON", id: "x", classes: "a b", text: "  Save file  ", rect: { x: -5, y: 999999, width: 10, height: 10 } })
  expect(el.text.length).toBeLessThanOrEqual(200)
  expect(el.rect.y).toBeGreaterThanOrEqual(0)
})
```

- [ ] **Step 2: Run to verify failure** — from `packages/desktop`: `bun test ./src/main/preview-host.test.ts`; expected FAIL (module missing).

- [ ] **Step 3: Implement the main process**

1. `preview-host.ts`: `isHostable(url)` (http/https + loopback/localhost only, reuse the predicate style of `browser-pane.ts`); `attach(win, url)` creates a `WebContentsView` (`webPreferences: { sandbox: true, contextIsolation: true, partition: "preview" }`), loads the URL, pushes onto `win.contentView.children`; `setBounds(win, rect)` DIP-corrected like `parseCaptureRect` (`ipc.ts:46–56`); `detach(win)`; `capture(win)` → `view.webContents.capturePage()` → data URL; `inspect(win, rect)` → `executeJavaScript` running a read-only collect script (getBoundingClientRect + tag/class/text under the rect — no page mutation, no event listeners installed) → `sanitizeElement` (clamp rect, truncate text 200 chars).
2. `ipc.ts`: `preview-host:attach/setBounds/detach/capture/inspect` handlers — self-contained style; every handler re-validates `isHostable` (defense in depth).
3. `preload/index.ts` + `types.ts`: typed optional members (`previewHost?`), mirroring `capturePage` wiring (`:181`, `types.ts:159`).
4. Renderer flag: card reads `nativeHost` from the preview config in `settings-v2/preview.tsx` toggle (payload pattern `preview-payload.ts:11–32`); `review-browser.tsx` prefers `window.api.previewHost?.attach(url)` when the flag resolves on and the API exists — falls back to the iframe otherwise (and whenever any host call rejects, tear down the view and return to iframe).

- [ ] **Step 4: Run tests to verify they pass** — `bun test ./src/main/preview-host.test.ts`; PASS. Smoke note (no automation possible for real Electron): manual smoke is the review pane with flag on/off.

- [ ] **Step 5: Typecheck + commit**

`bun typecheck` from `packages/desktop`, `packages/app`, `packages/opencode`; run `bun run generate` from `packages/client` (config schema changed). Commit:

```bash
git add packages/desktop/src/main/preview-host.ts packages/desktop/src/main/preview-host.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/preload packages/app/src/app.tsx packages/app/src/pages/session/review-browser.tsx packages/opencode/src/config/preview.ts packages/app/src/components/settings-v2/preview.tsx packages/app/src/components/settings-v2/preview-payload.ts
git commit -m "feat(desktop): native preview host with element inspection behind a flag"
```

---

### Task 4: Element metadata flows into annotations [item 5, Tier 2 payoff]

**Files:**
- Modify: `packages/app/src/pages/session/review-browser.tsx` (capture element metadata alongside the rect when native host active)
- Modify: `packages/app/src/utils/comment-note.ts` (`createCommentMetadata` ~L26–36 — extend `metadata.opencodeComment` with optional `element`)
- Test: `packages/app/src/utils/comment-note.test.ts` (if missing, create mirroring `hunk-revert.test.ts` style)

**Interfaces:**
- Consumes: Task 3's `inspect(rect)` element payload; `createCommentMetadata` (metadata passthrough is opaque server-side — verified in Phase-1 research).
- Produces: `metadata.opencodeComment.element?: { tag, id?, classes?, text?, rect }` on annotation comments; agent-visible via the existing comment-note renderer (extend `formatCommentNote` to append `element` when present, e.g. `… of path (button "Save file"): comment`).

- [ ] **Step 1: Write failing unit test**

```ts
test("comment note includes element metadata when present", () => {
  const note = formatCommentNote({
    file: "preview", selection: { start: 1, end: 1 }, comment: "too cramped",
    element: { tag: "BUTTON", text: "Save file", rect: { x: 10, y: 20, width: 80, height: 30 } },
  })
  expect(note).toContain('button "Save file"')
})
test("comment note unchanged without element", () => {
  const note = formatCommentNote({ file: "preview", selection: { start: 1, end: 1 }, comment: "too cramped" })
  expect(note).not.toContain("button")
})
```

- [ ] **Step 2: Run to verify failure**; expected FAIL.

- [ ] **Step 3: Implement** — wire `inspect` result into the structured `onAnnotate` payload (Task 1's shape gains `element?`), extend `createCommentMetadata` + `formatCommentNote`; guard for absent metadata.

- [ ] **Step 4: Run tests; PASS.**

- [ ] **Step 5: Typecheck + commit** — `feat(app): attach element metadata to browser annotations`.

---

### Task 5: Quick-entry settings toggle + screenshot attach [item 7]

**Files:**
- Create: `packages/desktop/src/main/screen-capture.ts` (+ `screen-capture.test.ts`)
- Modify: `packages/desktop/src/main/store-keys.ts` (new key beside `PINCH_ZOOM_ENABLED_KEY`)
- Modify: `packages/desktop/src/main/quick-entry.ts` (read toggle; keep hardcoded accelerator)
- Modify: `packages/desktop/src/main/ipc.ts` + `packages/desktop/src/preload/index.ts` + `packages/desktop/src/preload/types.ts` (toggle IPC + `screenshot` IPC)
- Modify: `packages/app/src/components/quick-entry.tsx` (attach control) + `packages/app/src/context/platform` consumer chain
- Modify: `packages/app/src/components/settings-keybinds.tsx` or settings-v2 general card (toggle UI)
- Modify: `packages/app/src/i18n/en.ts` + `flynncode-fallback.ts` (new keys)
- Test: `packages/desktop/src/main/screen-capture.test.ts` (injectable deps, `muse-auth.test.ts` style); source-contract updates

**Interfaces:**
- Consumes: quick-entry chain (`quick-entry.ts:1–26`, `ipc.ts:454–456`, preload `:136–139`, renderer relay `renderer/index.tsx:347`); `getDisplayBackend` precedent (`ipc.ts:124`, `preload/types.ts:38 LinuxDisplayBackend`); attachments pipeline (`prompt-input/attachments.ts:55–64`, clipboard-image flow `ipc.ts:382` → `attachments.ts:116–118`); pinch-zoom store+IPC+settings pattern (`windows.ts:131–143`, `store-keys.ts`).
- Produces: (a) `screenCapture(win): Promise<{ dataUrl } | null>` — `desktopCapturer.getSources` primary, `null` when the backend/portal denies (Wayland-without-portal); (b) settings toggle `quickEntryEnabled` (default true) consulted before `globalShortcut.register` at `index.ts:281`; (c) quick-entry overlay gains an "attach screenshot" affordance inserting an image part via the existing attachment flow.

- [ ] **Step 1: Write failing tests**

```ts
// screen-capture.test.ts (packages/desktop) — injectable style
test("returns null when the capture source list is empty", async () => {
  const result = await capturePrimaryScreen({ getSources: async () => [] })
  expect(result).toBeNull()
})
test("returns a data url from the first non-empty thumbnail", async () => {
  const result = await capturePrimaryScreen({ getSources: async () => [{ name: "screen", thumbnail: { toDataURL: () => "data:image/png;base64,AA" } }] })
  expect(result?.dataUrl).toBe("data:image/png;base64,AA")
})
```

```ts
// quick-entry.test.ts (extend existing source-contract)
expect(source).toContain("quickEntryEnabled")  // toggle consulted before register
```

- [ ] **Step 2: Run to verify failure** (both files); FAIL.

- [ ] **Step 3: Implement**

1. `screen-capture.ts`: injectable `capturePrimaryScreen({ getSources })` calling `desktopCapturer.getSources({ types: ["screen"], thumbnailSize: 1920 })` with a timeout; null-safe on failure. `electron` import stays inside the injectable default so tests never load Electron.
2. Toggle: store key `QUICK_ENTRY_ENABLED = "quick-entry.enabled"` (default true) in `store-keys.ts`; `quick-entry.ts` `registerQuickEntryShortcut()` early-returns when the stored toggle is false; IPC get/set beside the pinch-zoom pair (`ipc.ts` Deps + broadcast), settings toggle in `settings-keybinds.tsx` (keys `settings.shortcuts.quickEntry.*`).
3. Overlay attach: `quick-entry.tsx` adds an attach-button (hidden when `window.api?.screenshot` missing): calls `window.api.screenshot()` → blob → the existing image-part insertion (`attachments.ts` flow); new keys `quickEntry.attach` / `quickEntry.attachFailed` in en.ts + fallback registration.

- [ ] **Step 4: Run tests; PASS** (desktop capture module, quick-entry contracts, app parity test).

- [ ] **Step 5: Typecheck + commit** — `feat(desktop): quick entry settings toggle and screenshot attach`.

---

### Task 6: Memory entries become per-topic with update/remove [item 11]

**Files:**
- Modify: `packages/opencode/src/memory/memory.ts` (extend `Interface`: `update(entry: { scope, slug, text })`, `remove(entry: { scope, slug })`, `listDetailed()`; switch extraction output from per-day overwrite to per-topic slugs)
- Modify: `packages/opencode/src/session/prompt.ts` (`extractMemory` ~L1207–1256 — extraction prompt asks for topic slugs; write via `update` with dedup on existing slugs)
- Modify: `packages/opencode/src/memory/extract.ts` (prompt builder ~L10–18 — structured `SLUG:`/`TEXT:` output contract)
- Test: `packages/opencode/test/memory/memory.test.ts` (extend), `packages/opencode/test/memory/extract.test.ts` (extend)

**Interfaces:**
- Consumes: current `append` whole-file overwrite (`memory.ts:87–99`, `fs.writeWithDirs`), filename sanitize (`:27–33`), redaction at write (`:93`) / read (`:81`); glob layout (`*.md` at `:60–72`).
- Produces: `Memory.update({ scope, slug, text })` — create-or-replace one topic file `<sanitized-slug>.md` (redact on write; empty text after redaction → no-op or removal of empty file); `Memory.remove({ scope, slug })`; `extractMemory` writes per topic instead of one per-day file. `append` stays for compatibility but is deprecated to `update` internally (same-day merge bug fixed by removing the overwrite path).

- [ ] **Step 1: Write failing tests**

```ts
// memory.test.ts (extend)
it.live("update creates then replaces a topic entry", () => Effect.gen(function* () {
  const memory = yield* Memory
  yield* memory.update({ scope: "project", slug: "test-runner", text: "always use bun" })
  expect((yield* memory.load()).some((m) => m.content.includes("always use bun"))).toBe(true)
  yield* memory.update({ scope: "project", slug: "test-runner", text: "vitest only" })
  const after = yield* memory.load()
  expect(after.length).toBe(1)
  expect(after[0]?.content).toContain("vitest only")
  yield* memory.remove({ scope: "project", slug: "test-runner" })
  expect(yield* memory.load()).toEqual([])
}), { /* same env as existing memory.test.ts cases */ })
```

```ts
// extract.test.ts (extend): prompt asks for SLUG/TEXT pairs; parse extracts topics
test("extraction prompt demands topic slugs", () => {
  const prompt = MemoryExtract.buildExtractionPrompt({ conversation: "..." })
  expect(prompt).toContain("SLUG:")
})
```

- [ ] **Step 2: Run to verify failure** — from `packages/opencode`: `bun test ./test/memory/`; FAIL.

- [ ] **Step 3: Implement**

1. `memory.ts`: add `update`/`remove` with the same sanitize + redact gates as `append`; slug → filename via the existing sanitize (extend it to accept a longer slug charset if needed, keeping traversal-safe).
2. `extract.ts`: rewrite the prompt contract — output one or more blocks: `SLUG: <kebab-topic>` then 1–3 bullet lines; keep "NOTHING TO REMEMBER"; keep ≤N blocks bounded.
3. `prompt.ts` `extractMemory`: parse blocks; for each, `memory.update({ scope: "project", slug, text: redact(bullets) })` (redact again at write — belt and suspenders); empty-text-after-redaction blocks are skipped; delete a topic whose update text is empty (via `remove`).

- [ ] **Step 4: Run tests; PASS** (full `./test/memory/`).

- [ ] **Step 5: Typecheck + commit** — `feat(opencode): per-topic memory entries with update and remove`.

---

### Task 7: Agent self-curation via a `memory` tool [item 11]

**Files:**
- Create: `packages/opencode/src/tool/memory.ts` (+ description txt `memory.txt`)
- Modify: `packages/core/src/v1/config/permission.ts` (`Info` known keys gains `memory`)
- Modify: tool registry wiring (mirror how `session-manage` registers — find the registry list consumed in `session/tools.ts` / registry module)
- Test: `packages/opencode/test/tool/memory-tool.test.ts` (new)

**Interfaces:**
- Consumes: `Tool.define` pattern (`tool/session-manage.ts`), `ctx.ask` permission gating, `Memory.node` service (Task 6's `update`/`remove`/`listDetailed`).
- Produces: tool `memory` with params `{ action: "save" | "remove" | "list", scope?: "global" | "project", slug?, text? }`; permission key `memory` (default `ask`, like `archive`) gated via `ctx.ask({ permission: "memory", patterns: [slug], always: [scope] })` — once-approved per scope sticks for the session; disabled agents see nothing (existing `Permission.disabled` mechanics).

- [ ] **Step 1: Write failing test** — instance-style test (mirror `test/tool/session-manage` or task tests' `it.instance` patterns): save→loads in `memory.listDetailed`, redaction enforced on save (secret fixture → `[redacted]`), ask gate surfaces once then "always" allows, remove works, disabled config → tool hidden.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — follow `session-manage.ts`'s exact structure (Parameters schema, `ctx.ask`, `ctx.metadata`, `Effect.orDie`); tool writes only via the Memory service (never raw FS). Tool description (`memory.txt`) documents: use for durable working conventions; redaction enforced; global scope = outside the repo, project scope = `.opencode/memories/` (committable).

- [ ] **Step 4: Run tests; PASS.** Full `bun test ./test/tool/ ./test/memory/ ./test/permission/` (permission dir because the known-key change touches `stripPolicyKeys` paths).

- [ ] **Step 5: Typecheck + commit** — `feat(opencode): memory tool for agent self-curation`.

---

### Task 8: Memory extraction triggers at compact/idle [item 11]

**Files:**
- Modify: `packages/opencode/src/session/compaction.ts` (fold a memory-extraction call at pre-compact, ~L382 hook region)
- Modify: `packages/opencode/src/session/prompt.ts` (`extractMemory` gains a reusable `extractMemoryFor(messages)` core; compact/idle call sites reuse it)
- Test: extend `packages/opencode/test/session/` (mirror the status-hooks/compaction test style; grep `test/compaction` first)

**Interfaces:**
- Consumes: extraction core (`prompt.ts:1207–1256`), compaction hook sites (`compaction.ts:382/:587`), `MemoryExtract.shouldExtract` gate (reuse `min_turns` unchanged).
- Produces: extraction also fires (best-effort, `Effect.ignore` + forked, never blocking) at pre-compaction and at idle (`runIdle` path — mirror how extractMemory forks at drain completion, `prompt.ts:1534`), with the min_turns gate unchanged.

- [ ] **Step 1: Write failing tests** (extend the existing compaction/idle test file — locate via grep; if a compaction test file doesn't exist, create `packages/opencode/test/session/compaction-memory.test.ts`):

```ts
it.effect("compaction triggers memory extraction above min_turns", () =>
  Effect.gen(function* () {
    // arrange: memory enabled config + a session with min_turns user messages;
    // stub the LLM with a fixed SLUG/TEXT reply (reuse the approval-mode/summary
    // stub style used for extractMemory in prompt tests)
    // act: run the pre-compact path the same way compaction.ts:382 fires hooks
    // assert: memory.load() contains the topic slug
  }))
it.effect("compaction skips extraction below min_turns", () =>
  Effect.gen(function* () {
    // assert: memory.load() empty after compact with < min_turns messages
  }))
```

- [ ] **Step 2:** FAIL. **Step 3:** refactor `extractMemory` into a reusable core `extractMemoryFor(messages)` + call from the two new sites (dedupe: compare content hash before `update` and skip no-op writes so compact+idle+drain at one boundary doesn't triple-write). **Step 4:** PASS (full `./test/memory/` + touched session suites). **Step 5:** commit `feat(opencode): curate memories at compaction and idle boundaries`.

---

### Task 9: Memory settings surface + redaction extensions [item 11]

**Files:**
- Modify: `packages/app/src/components/settings-v2/general.tsx` + new payload/controller (copy `hooks-payload.ts` naming pattern → `memory-payload.ts`)
- Modify: `packages/opencode/src/memory/redact.ts` (extend patterns: JWT `eyJ…`, `anthropic` key shapes, GCP `AIza…`, Stripe `sk_live|rk_live_…`)
- Modify: `packages/app/src/i18n/en.ts` + `flynncode-fallback.ts` (settings.memory.* keys)
- Test: `packages/opencode/test/memory/redact.test.ts` (extend); app parity + settings-v2 source-contract test

**Interfaces:**
- Consumes: settings payload/controller split pattern (`hooks-payload.ts`, `general-controllers.ts`); config write path used by Phase-1 Task 11 (`permission` block) — same full-value construction discipline for the `memory` block; redact table (`redact.ts:1–14`).
- Produces: settings row: enable toggle + min_turns numeric + hint text distinguishing global (`~/.local/share/flynncode/memories`-equivalent via `Global.data`, shown as-is) vs project (`.opencode/memories/`, committable).

- [ ] **Step 1: Write failing tests**

```ts
// redact.test.ts (extend)
test("jwt, anthropic, gcp and stripe patterns redact", () => {
  const input = "jwt eyJhbGciOiJIUzI1NiJ9.e30.KKkK; anthropic sk-ant-api03-x; gcp AIzaSyA1; stripe sk_live_51abc"
  const out = redactSecrets(input)
  expect(out).not.toContain("eyJ")
  expect(out).not.toContain("sk-ant")
  expect(out).not.toContain("AIzaSy")
  expect(out).not.toContain("sk_live_")
})

// permissions settings contract (packages/app/settings-v2 source-contract test)
test("memory settings writes the memory config block", () => {
  const source = readFileSync(new URL("./general.tsx", import.meta.url), "utf8")
  expect(source).toContain('"memory"')
  expect(source).toContain('"min_turns"')
})
```

---

### Task 10: Sandbox containment honors attached extra folders [item 13 — bug fix]

**Files:**
- Modify: `packages/opencode/src/session/tools.ts` (~L74–76 `sandboxDirs`; write containment ~L113–123)
- Test: `packages/opencode/test/session/tools.test.ts` (extend the sandbox block ~L276–311)

**Interfaces:**
- Consumes: `InstanceContext.additionalDirectories` (available in the same resolve layer); `Sandbox.isPathAllowed(target, session.directory, sandboxDirs, level)` (`permission/sandbox.ts:34–44`).
- Produces: **session-scoped** containment: `sandboxDirs` union = `project.sandboxes(session.projectID)` ∪ the session's own `InstanceContext.additionalDirectories` (NOT the cross-session `SessionFolders.forDirectory` union — a session must not inherit another session's extras; the instance ctx already carries this session's set per instance-store boot).

- [ ] **Step 1: Write failing test** (extend tools.test.ts sandbox block):

```ts
it.effect("workspace-write allows edits inside an attached additional directory", () =>
  Effect.gen(function* () {
    // resolve SessionTools with a context whose additionalDirectories include extra/
    // execute write on <extra>/file → succeeds
    // execute write on /etc/… → still SandboxViolationError
  }))
```

- [ ] **Step 2:** FAIL (extra-path write currently `SandboxViolationError`). **Step 3:** implement the union (`sandboxDirs`). **Step 4:** PASS (existing sandbox tests unchanged). **Step 5:** commit `fix(opencode): allow workspace-write inside a session's attached folders`.

---

### Task 11: Extras in the file tree, environment prompt, and nested AGENTS walk [item 13]

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts` (list endpoint ~L86 — enumerate extras)
- Modify: `packages/opencode/src/session/system.ts` (~L71–107 — announce "Additional project folders" after the worktree/env block)
- Modify: `packages/opencode/src/session/instruction.ts` (`resolve` walk ~L217 — nested `.opencode`/AGENTS walk stops at whatever boundary root contains the file: primary OR any extra)
- Test: extend `packages/opencode/test/instruction/multifold-basepaths.test.ts` (keep the base-path pin!) + a file-list test (`test/server/httpapi-session-folders.test.ts` add cases)

**Interfaces:**
- Consumes: `file.ts` boundary code (`:104–116` selects owning root already); `system.ts` environment template; `instruction.ts` nested-file attach walk (`current.startsWith(root)`).
- Produces: (a) file tree/search enumerates primary + extras (each scoped to its own root, per existing read-root selection); (b) system prompt line: `Additional workspace folders: <path>…` (localized? No — system prompt is English to the model, plain line); (c) nested AGENTS.md inside an extras root attaches when the walked file belongs to that extra (without crossing primary boundary rules).

- [ ] **Step 1:** failing tests (file list includes extra path; env includes folders line; nested attach for extra-resident instruction file; base-paths pin unchanged). **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(opencode): surface attached folders to the file tree, prompt, and nested instructions`.

---

### Task 12: Per-agent sandbox-mode override [item 14]

**Files:**
- Modify: `packages/core/src/v1/config/agent.ts` (`TolerantSandbox` L27–34/109 — admit `SandboxMode` values; normalize degradation kept)
- Modify: `packages/opencode/src/session/tools.ts` (~L73 policy resolution — override `policy.sandbox` from the agent's sandbox when the value is a `SandboxMode`)
- Modify: `packages/opencode/src/tool/task.ts` (~L151, ~L229–236 — thread the resolved mode into the child: `sessions.setMetadata({ sandbox: mode })` beside `worktree`)
- Modify: `packages/opencode/src/agent/subagent-permissions.ts` (`sandboxRules` ~L41–55 — map `readonly` to external_directory confinement like `restricted`, keep named profiles)
- Test: `packages/core/test/agent-config.test.ts` (extend), `packages/opencode/test/subagent-permissions.test.ts` / tools.test.ts (extend)

**Interfaces:**
- Consumes: `resolveSessionPolicy(cfg.permission)` (`core/v1/config/permission.ts:74–81`) — resolution precedence: session metadata `sandbox` (task-dispatched child) → agent config `cfg.agent[name].sandbox` → global policy; `SandboxMode` literals unchanged.
- Produces: agent `sandbox: "readonly"` in markdown or JSON config yields a readonly child even under global `workspace-write`; named profile `restricted` keeps current behavior; tolerant decode never fails config load.

- [ ] **Step 1:** failing tests (agent-config decode accepts `readonly/workspace-write/full-access`; tools.ts policy honors agent override; task.ts child metadata carries mode; subagent permissions confinement for readonly). **Step 2:** FAIL. **Step 3:** implement (resolution in tools.ts reads `cfg.agent?.[input.agent.name]?.sandbox` then session metadata override from `session.metadata.sandbox` — verify metadata typing; extend `sandboxRules` for readonly). **Step 4:** PASS (full tools/permission/config suites). **Step 5:** commit `feat(opencode): per-agent sandbox-mode override`.

---

### Task 13: Isolation error fallback + frontmatter decode pin + dead key [item 14 leftovers]

**Files:**
- Modify: `packages/opencode/src/tool/task.ts` (~L159, ~L212, ~L466) — translate `Worktree.NotGitError`/`CreateFailedError` into a clean `ToolExecutionError`-style failure with an actionable message ("isolation: worktree requires a git project") instead of `Effect.orDie` defect leak
- Test: `packages/opencode/test/tool/task-isolation.test.ts` (extend: non-git directory → clean error text, not defect)
- Test: `packages/opencode/test/config/markdown.test.ts` (extend: agent `.md` frontmatter with `isolation: worktree`, `sandbox: readonly`, `model:` decodes into `cfg.agent`)
- Modify: `packages/app/src/i18n/en.ts` — wire or delete dead key `session.subagents.isolationWorktree` (`:915`): wire it into the new-session workspace selector's isolation hint if the surface supports it cheaply (prompt-workspace-selector), else delete the key + fallback entry

- [ ] **Step 1: Write failing tests**

```ts
// task-isolation.test.ts (extend) — fixture: tmpdir WITHOUT the git flag
it.instance("worktree isolation on a non-git directory fails cleanly", () =>
  Effect.gen(function* () {
    const result = yield* def.execute(
      { subagent_type: "general", prompt: "hi", isolation: "worktree", cleanup: "retain" },
      ctx,
    ).pipe(Effect.either)
    expect(Either.isLeft(result)).toBe(true)
  }))

// markdown.test.ts (extend) — tmp .opencode/agent/<name>.md frontmatter:
//   isolation: worktree / sandbox: readonly / model: provider/x
test("agent markdown frontmatter decodes isolation, sandbox and model", () => {
  expect(info.isolation).toBe("worktree")
  expect(info.sandbox).toBe("readonly")
  expect(info.model).toBe("provider/x")
})
```

- [ ] **Step 2: Run to verify failure** — from `packages/opencode`: `bun test ./test/tool/task-isolation.test.ts ./test/config/markdown.test.ts`; FAIL (clean-failure path absent; frontmatter already decodes but untested).
- [ ] **Step 3: Implement** — error translation in `task.ts` (~L466 area: catch `Worktree.NotGitError`/`CreateFailedError` from the create pipeline, `Effect.fail` with an actionable message; do not broad-catch); i18n key decision (wire into `prompt-workspace-selector`'s isolation hint or delete key + fallback entry).
- [ ] **Step 4: Run tests; PASS.**
- [ ] **Step 5: Commit** (split commits as listed in Files).

---

### Task 14: Hook output-shape parity fixes [item 15 gaps #1–#2]

**Files:**
- Modify: `packages/opencode/src/hooks/executor.ts` (`collectCommand` observe branches ~L366–391 — non-JSON non-empty stdout → `additionalContext` for SessionStart/SubagentStart/UserPromptSubmit; exit-2 reason reads `spawned.stderr.trim() || spawned.stdout.trim() || fallback` ~L367; update comment block ~L18)
- Test: `packages/opencode/test/hooks/executor.test.ts` (extend — real-process scripts per its `it.live` pattern)

**Interfaces:**
- Consumes: current behavior non-JSON → `{}` (`executor.ts:389`), stdout-only reason (`:367`); Codex doc semantics (plain stdout = developer context on observe events; stderr carries the exit-2 reason).
- Produces: (a) observe events consume plain stdout as `additionalContext` (respect `additionalContextLimit` truncation); (b) exit-2 reason prefers stderr.

- [ ] **Step 1: Write failing executor tests** (extend `test/hooks/executor.test.ts`, real-process scripts):

```ts
it.live("observe events promote plain stdout to additionalContext", () =>
  Effect.gen(function* () {
    // SessionStart hook: printf 'Build docs live in ./docs'; non-JSON, exit 0
    // assert: returned context carries the stdout line (within the limit)
  }))
it.live("exit 2 reason prefers stderr over stdout", () =>
  Effect.gen(function* () {
    // script: echo "stdout says no" ; echo "stderr reason" >2 ; exit 2
    // assert: denial reason is the stderr string
  }))
```

- [ ] **Step 2: Run to verify failure**; FAIL. **Step 3: Implement** per Files. **Step 4: PASS** (`bun test ./test/hooks/`). **Step 5: Commit** `feat(opencode): hook stdout context and stderr denial reasons`.

---

### Task 15: disableAllHooks kill switch + additive hook payload fields [item 15 gaps #5–#6]

**Files:**
- Modify: `packages/core/src/v1/config/hooks.ts` (top-level `disableAllHooks?: boolean` default false in hooks Info/schema)
- Modify: `packages/opencode/src/hooks/executor.ts` (`trusted()` ~L196–204 consults the flag; managed hooks unaffected-by-flag? NO — kill switch disables everything, managed pre-trust included; document)
- Modify: `packages/opencode/src/hooks/executor.ts` payload builders (~L565–571, ~L591–598, ~L623 — add `cwd`, `model`, `permission_mode` where the context has them; additive optional fields)
- Test: `test/hooks/trust.test.ts` (extend — flag disables managed too), executor payload test

**Interfaces:**
- Consumes: existing trust machinery (`trust.ts`, `managed.ts` pre-trust), payload context objects at the call sites.
- Produces: a global kill switch honored before any spawn; payload parity fields.

- [ ] **Step 1: Write failing test** (extend `test/hooks/trust.test.ts`):

```ts
it.live("disableAllHooks suppresses even managed hooks", () => Effect.gen(function* () {
  // config with hooks.disableAllHooks: true + a managed (pre-trusted) hook;
  // run the executor path from trust.test.ts's configLayer() helper
  // assert: no spawn occurred and no deny fired (event skipped entirely)
}))
```

- [ ] **Step 2: Run to verify failure**; FAIL. **Step 3: Implement** — flag consulted at the top of `trusted()`/spawn gate with a comment that the kill switch includes managed hooks; payload builders add `cwd`, `model`, `permission_mode` optional fields from available context. **Step 4: PASS** (`bun test ./test/hooks/`). **Step 5: Commit** `feat(opencode): hooks kill switch and cwd/model context fields`.

---

### Task 16: Hooks documentation page [item 15 gap #8]

**Files:**
- Create: `packages/web/src/content/docs/hooks-reference.md` (or wherever existing doc pages live — locate the docs content dir; mirror its frontmatter/conventions)
- Content: event list (12), handler shapes (command/mcp_tool), output contracts (JSON decision shapes, exit codes, fail-closed), matchers, trust model (canonical hash + script content hashes, managed pre-trust), kill switch, `${field}` expansion for mcp_tool, context plumbing (sticky vs per-turn vs report-only), examples per event.

- [ ] Steps: locate docs dir (`packages/web/src/content/`); write the page covering the ground-truth matrix from the research (12 events); no i18n (web docs are English); commit `docs(web): hooks reference`.

---

## Deferred from this phase (documented deferrals)

- **V2 system-context memory source** (item 11) — moving `Memory.Service` into core for `SystemContextRegistry` is an architecture change; V1 injection exists; revisit as its own design.
- **Config-declared project directories key** (item 13) — extras are session-scoped today by design; a project-level key needs a scope decision (per-project `root` rows vs config). Defer.
- **Quick-entry dedicated frameless window + background dispatch** (item 7) — current raise-the-app + overlay satisfies the spec's letter; a separate window is a bigger Electron surface. Defer.
- **V2 core task-dispatch isolation** (item 14) — needs a Location-placement design in core; defer to its own plan.
- **UserPromptSubmit file-hook block shape** (item 15 #3) and **path placeholder env expansion** (#7) — documented deviations; revisit if requested.
- **PreCompact `continue:false` semantics alignment** (#4) — behavior change risk; documented.

## Verification (phase gate)

```bash
# packages/opencode
bun typecheck && bun test ./test/memory/ ./test/tool/ ./test/session/ ./test/hooks/ ./test/instruction/ ./test/config/ ./test/permission/
# packages/core
bun typecheck && bun test ./test/agent-config.test.ts ./test/command.test.ts
# packages/app
bun typecheck && bun run test:unit
# packages/desktop
bun typecheck && bun test ./src/main/
# packages/client (after schema changes) — bun run generate already run by Task 3
```

Manual smoke: annotate with screenshot (desktop), point-mode mark, native host toggle + inspect metadata, quick-entry hotkey toggle + screenshot attach, memory tool save/list/remove + settings toggle, extras edit under workspace-write + file tree + env prompt, agent sandbox readonly child, isolation error on non-git, hook stdout context + kill switch.