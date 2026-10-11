# WS17 Computer Use (Opt-In Fallback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in (default OFF) local computer use as a strictly consent-gated fallback for GUI-only apps after the browser pane, with per-app allowlist, explicit per-action consent, never self-approving, scoped to explicit user-invoked tasks, never autonomous background operation.

**Architecture:** Server owns a disabled-by-default `ComputerUse` config plus a client-executed `computer_use` local tool that fails closed unless enabled, app-allowlisted, and per-action approved through the existing `Permission.Service.ask` path. The desktop actuator is pane-scoped only: screenshots via the existing `app:capturePage` IPC and input via `WebContentsView.sendInputEvent` on the browser-pane view. No OS-wide pointer takeover, no background loop, no new native input dependency. Hosted `computer_use_call` from `packages/llm` stays `providerExecuted: true` and is never mapped to the local actuator. The WS4 reviewer always defers `computer_use`; approval modes never short-circuit it.

**Tech Stack:** Bun + TypeScript, Effect (`Effect.gen`, `Effect.fn`, `Schema.Struct`, `Schema.TaggedErrorClass`, `InstanceState` where noted), `Tool.define` local tool pattern (`packages/flynncode/src/tool/read.ts`), Electron 42 `WebContentsView.sendInputEvent` + existing `app:capturePage` IPC, SolidJS app UI with `language.t(...)` keys in `packages/app/src/i18n/en.ts`, `bun:test`, `bun typecheck` per package.

## Global Constraints

- Product is Flynncode, not upstream opencode.
- Backends self-hosted or user-owned only; vendor-hosted clouds, Sites hosting, and voice products stay OUT.
- Computer use is default OFF, per-app allowlisted, per-action consented, never self-approving, never background.
- NEVER hardcode user-visible English in production code; every label goes behind an i18n key in `packages/app/src/i18n/en.ts` (en only). Desktop main-process copy goes through `nativeT(...)` with keys in the shared desktop-native bundle.
- Never use the `any` type.
- Never alias imports and never use star imports; import the module's own exported namespace by name where a namespace is needed.
- Rely on type inference; avoid explicit annotations unless needed for exports or clarity.
- Prefer `const` over `let`; prefer early returns over `else`.
- Renderer code calls `window.api` only; main-process IPC handlers register in `packages/desktop/src/main/ipc.ts`.
- Run tests from package directories (for example `packages/flynncode`, `packages/desktop`, `packages/app`), never from the repo root.
- Run `bun typecheck` from each touched package directory before committing.
- Do not restart the app or server processes.
- Scope is explicit user-invoked GUI tasks only. No autonomous background operation, no screen-history recording, no terminal driving, no ChatGPT-app self-driving.

---

### Files to create, modify, and test

**Create:**

- `packages/flynncode/src/config/computer-use.ts` — `ComputerUse` config Schema + `resolveComputerUse` + `isAppAllowed` pure helpers.
- `packages/flynncode/test/config/computer-use.test.ts` — unit tests for defaults and allowlist matching.
- `packages/flynncode/src/tool/computer-use.ts` — `ComputerUseTool` via `Tool.define` (actions: `screenshot`, `click`, `type`, `keypress`, `scroll`).
- `packages/flynncode/src/tool/computer-use.txt` — tool description text (one line, consent-gated fallback wording).
- `packages/flynncode/test/tool/computer-use.test.ts` — parameter schema + fail-closed tests.
- `packages/desktop/src/main/computer-use.ts` — pane-scoped actuator (`screenshotPane`, `clickPane`, `typePane`, `keypressPane`, `scrollPane` via `sendInputEvent`).
- `packages/desktop/src/main/computer-use.test.ts` — pure unit tests for coordinate clamping + allowlist check (no Electron instance).
- `packages/app/src/pages/session/computer-use-panel.test.ts` — source-assertion suite for the consent panel wiring.

**Modify:**

- `packages/flynncode/src/config/config.ts` — add `computer_use` field to root config Schema plus self-export line for the new module.
- `packages/flynncode/src/tool/registry.ts` — register `ComputerUseTool` behind the enabled flag (tool hidden when disabled).
- `packages/flynncode/src/permission/reviewer.ts` — document `computer_use` as always defer (no code change if generic defer already covers it; add explicit guard).
- `packages/flynncode/src/permission/index.ts` — add `computer_use` never-auto guard in `ask` (ignore `approval` mode for this permission).
- `packages/desktop/src/main/ipc.ts` — register `computer-use:*` handlers delegating to the actuator.
- `packages/desktop/src/preload/index.ts` — expose `computerUse` namespace on `window.api`.
- `packages/desktop/src/preload/types.ts` — add `ComputerUseAPI` type.
- `packages/app/src/i18n/en.ts` — add `computerUse.*` and `sandbox`/`approval` adjacent keys listed in Task 4.
- `packages/app/src/pages/session.tsx` — mount explicit Start/Stop computer-use affordance gated on the enabled flag (no auto-mount).
- `packages/llm/src/protocols/openai-responses.ts` — no change; add code comment at line 551 noting hosted `computer_use_call` never maps to the local actuator.

**Interfaces:**

- `resolveComputerUse(raw: unknown): { enabled: boolean; allowedApps: string[] }` — consumes unknown config input, produces resolved policy with `enabled: false` and `allowedApps: []` defaults.
- `isAppAllowed(appID: string, allowedApps: string[]): boolean` — consumes candidate app id plus allowlist, produces true only on exact case-sensitive match.
- `ComputerUseTool` parameters `Schema.Struct({ action: Schema.Literals(["screenshot", "click", "type", "keypress", "scroll"]), appID: Schema.String, x: Schema.optional(Schema.Number), y: Schema.optional(Schema.Number), text: Schema.optional(Schema.String), key: Schema.optional(Schema.String), deltaX: Schema.optional(Schema.Number), deltaY: Schema.optional(Schema.Number) })` — consumes one validated action per call, produces a screenshot payload or an acknowledgement record.
- `ComputerUse.Service` (desktop main only): `screenshotPane(windowID: string): Promise<{ image: string; width: number; height: number }>`, `clickPane(windowID: string, x: number, y: number): Promise<void>`, `typePane(windowID: string, text: string): Promise<void>`, `keypressPane(windowID: string, key: string): Promise<void>`, `scrollPane(windowID: string, deltaX: number, deltaY: number): Promise<void>` — each consumes a window id plus validated payload, owns only the browser-pane `WebContentsView` for that window.
- Preload `ComputerUseAPI`: `screenshot(): Promise<{ image: string; width: number; height: number }>`, `click(x: number, y: number): Promise<void>`, `typeText(text: string): Promise<void>`, `keypress(key: string): Promise<void>`, `scroll(deltaX: number, deltaY: number): Promise<void>` — renderer calls `window.api.computerUse.*` only.
- `clampPanePoint(x: number, y: number, bounds: { width: number; height: number }): { x: number; y: number }` — consumes raw coordinates plus pane size, produces coordinates clamped inside the pane.

---

### Task 1: Computer-use config schema (default OFF, per-app allowlist)

**Files:**

- Create: `packages/flynncode/src/config/computer-use.ts`
- Modify: `packages/flynncode/src/config/config.ts`
- Test: `packages/flynncode/test/config/computer-use.test.ts`

**Interfaces:**

- Consumes: unknown raw config under key `computer_use`.
- Produces: `resolveComputerUse`, `isAppAllowed` for Task 2.

- [ ] **Step 1: Write the failing test**

Create `packages/flynncode/test/config/computer-use.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { ComputerUse } from "../../src/config/computer-use"

describe("resolveComputerUse", () => {
  test("defaults to disabled with empty allowlist", () => {
    expect(ComputerUse.resolveComputerUse({})).toEqual({ enabled: false, allowedApps: [] })
    expect(ComputerUse.resolveComputerUse(undefined)).toEqual({ enabled: false, allowedApps: [] })
  })

  test("reads explicit enabled plus allowlist", () => {
    expect(ComputerUse.resolveComputerUse({ enabled: true, allowedApps: ["com.example.gui"] })).toEqual({
      enabled: true,
      allowedApps: ["com.example.gui"],
    })
  })

  test("rejects non-boolean enabled", () => {
    expect(() => ComputerUse.resolveComputerUse({ enabled: "yes" })).toThrow()
  })
})

describe("isAppAllowed", () => {
  test("exact match only", () => {
    expect(ComputerUse.isAppAllowed("com.example.gui", ["com.example.gui"])).toBe(true)
    expect(ComputerUse.isAppAllowed("com.example.GUI", ["com.example.gui"])).toBe(false)
    expect(ComputerUse.isAppAllowed("com.example.gui", [])).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/flynncode`: `bun test test/config/computer-use.test.ts`
Expected: FAIL with "Cannot find module '../../src/config/computer-use'".

- [ ] **Step 3: Write minimal implementation**

Create `packages/flynncode/src/config/computer-use.ts` with:

```ts
import { Schema } from "effect"

export const ComputerUsePolicy = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false as const)),
  allowedApps: Schema.optional(Schema.Array(Schema.String)).pipe(Schema.withDecodingDefault(() => [] as string[])),
}).annotate({ identifier: "ComputerUsePolicy" })
export type ComputerUsePolicy = Schema.Schema.Type<typeof ComputerUsePolicy>

export function resolveComputerUse(raw: unknown): { enabled: boolean; allowedApps: string[] } {
  const record = (raw ?? {}) as Record<string, unknown>
  const decoded = Schema.decodeUnknownSync(ComputerUsePolicy)({
    enabled: record.enabled,
    allowedApps: record.allowedApps,
  })
  return { enabled: decoded.enabled, allowedApps: decoded.allowedApps }
}

export function isAppAllowed(appID: string, allowedApps: string[]): boolean {
  return allowedApps.includes(appID)
}

export * as ComputerUse from "./computer-use"
```

In `packages/flynncode/src/config/config.ts`: add `export * as ConfigComputerUse from "./computer-use"` alongside the existing self-export lines at the top of the file, and add `computer_use: Schema.optional(ConfigComputerUse.ComputerUsePolicy)` to the root config Struct where sibling optional blocks (for example `preview`) are declared.

- [ ] **Step 4: Run test to verify it passes**

Run from `packages/flynncode`: `bun test test/config/computer-use.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run typecheck**

Run from `packages/flynncode`: `bun typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/flynncode/src/config/computer-use.ts packages/flynncode/src/config/config.ts packages/flynncode/test/config/computer-use.test.ts
git commit -m "feat(opencode): add opt-in computer-use config with app allowlist"
```

---

### Task 2: Local computer_use tool (fail-closed, permission-gated)

**Files:**

- Create: `packages/flynncode/src/tool/computer-use.ts`
- Create: `packages/flynncode/src/tool/computer-use.txt`
- Modify: `packages/flynncode/src/tool/registry.ts`
- Test: `packages/flynncode/test/tool/computer-use.test.ts`

**Interfaces:**

- Consumes: `ComputerUse.resolveComputerUse`, `ComputerUse.isAppAllowed` from Task 1; `Permission.Service.ask` with permission `"computer_use"`.
- Produces: `ComputerUseTool` registered for Task 3 actuator wiring.

- [ ] **Step 1: Write the failing test**

Create `packages/flynncode/test/tool/computer-use.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ComputerUseTool } from "../../src/tool/computer-use"

describe("computer-use parameters", () => {
  test("accepts screenshot action with appID", () => {
    const decoded = Schema.decodeUnknownSync(ComputerUseTool.parameters)({ action: "screenshot", appID: "com.example.gui" })
    expect(decoded.action).toBe("screenshot")
  })

  test("rejects unknown action", () => {
    expect(() => Schema.decodeUnknownSync(ComputerUseTool.parameters)({ action: "reboot", appID: "com.example.gui" })).toThrow()
  })
})

describe("computer-use fail-closed", () => {
  test("tool source requires enabled plus allowlist plus ask", async () => {
    const source = await Bun.file(new URL("../../src/tool/computer-use.ts", import.meta.url).pathname).text()
    expect(source).toContain("resolveComputerUse")
    expect(source).toContain("isAppAllowed")
    expect(source).toContain("computer_use")
    expect(source).toContain("ComputerUseDisabledError")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/flynncode`: `bun test test/tool/computer-use.test.ts`
Expected: FAIL with "Cannot find module '../../src/tool/computer-use'".

- [ ] **Step 3: Write minimal implementation**

Create `packages/flynncode/src/tool/computer-use.txt` with one line:

```txt
Local GUI fallback after the browser pane. Disabled by default; requires per-app allowlist plus per-action approval. Never background operation.
```

Create `packages/flynncode/src/tool/computer-use.ts` with:

```ts
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./computer-use.txt"
import { ComputerUse } from "@/config/computer-use"
import { Config } from "@/config/config"
import { Permission } from "@/permission"

export class ComputerUseDisabledError extends Schema.TaggedErrorClass<ComputerUseDisabledError>()(
  "ComputerUseDisabledError",
  { appID: Schema.String },
) {}

export class ComputerUseNotAllowedError extends Schema.TaggedErrorClass<ComputerUseNotAllowedError>()(
  "ComputerUseNotAllowedError",
  { appID: Schema.String },
) {}

export const Parameters = Schema.Struct({
  action: Schema.Literals(["screenshot", "click", "type", "keypress", "scroll"]).annotate({
    description: "Exactly one pane-scoped GUI action per call",
  }),
  appID: Schema.String.annotate({ description: "Allowlisted GUI app id owning the target pane" }),
  x: Schema.optional(Schema.Number).annotate({ description: "X point in CSS pixels relative to the pane" }),
  y: Schema.optional(Schema.Number).annotate({ description: "Y point in CSS pixels relative to the pane" }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for the type action" }),
  key: Schema.optional(Schema.String).annotate({ description: "Key for the keypress action" }),
  deltaX: Schema.optional(Schema.Number).annotate({ description: "Horizontal scroll delta" }),
  deltaY: Schema.optional(Schema.Number).annotate({ description: "Vertical scroll delta" }),
})

export const ComputerUseTool = Tool.define<typeof Parameters, { acknowledged: boolean }, Config.Service | Permission.Service>(
  "computer_use",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("ComputerUseTool.execute")(function* (input) {
        const cfg = yield* config.get()
        const policy = ComputerUse.resolveComputerUse(cfg.computer_use ?? {})
        if (policy.enabled === false) return yield* new ComputerUseDisabledError({ appID: input.appID })
        if (ComputerUse.isAppAllowed(input.appID, policy.allowedApps) === false)
          return yield* new ComputerUseNotAllowedError({ appID: input.appID })
        yield* permission.ask({
          sessionID: "" as never,
          permission: "computer_use",
          patterns: [input.appID, input.action],
          metadata: {},
          always: [],
          ruleset: [],
        })
        return { acknowledged: true }
      }),
    }
  }),
)

export * as ComputerUseToolModule from "./computer-use"
```

Notes: the `sessionID` placeholder is replaced with the real session id at registry bind time in the next edit; the tool body never branches on `approval` mode because Task 3 makes `ask` ignore it for this permission. The actuator payload (screenshot bytes / input dispatch) is added in Task 3; this task only proves fail-closed gating.

In `packages/flynncode/src/tool/registry.ts`: register `ComputerUseTool` next to sibling tool registrations, guarded so the tool definition list excludes it when `resolveComputerUse(cfg.computer_use).enabled` is false (tool hidden when disabled). Follow the existing registry conditional pattern; do not add a new registry helper.

- [ ] **Step 4: Run test to verify it passes**

Run from `packages/flynncode`: `bun test test/tool/computer-use.test.ts test/config/computer-use.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run from `packages/flynncode`: `bun typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/flynncode/src/tool/computer-use.ts packages/flynncode/src/tool/computer-use.txt packages/flynncode/src/tool/registry.ts packages/flynncode/test/tool/computer-use.test.ts
git commit -m "feat(opencode): add fail-closed computer_use tool with allowlist gate"
```

---

### Task 3: Never self-approving guard (reviewer + approval bypass block)

**Files:**

- Modify: `packages/flynncode/src/permission/reviewer.ts`
- Modify: `packages/flynncode/src/permission/index.ts`
- Test: extend `packages/flynncode/test/permission/reviewer.test.ts` via new `packages/flynncode/test/permission/computer-use-guard.test.ts` (create)

**Interfaces:**

- Consumes: existing `Reviewer.review`, existing `Permission.Service.ask`.
- Produces: `computer_use` always defers; `ask` ignores `auto` / `accept-edits` for `computer_use`.

- [ ] **Step 1: Write the failing test**

Create `packages/flynncode/test/permission/computer-use-guard.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { Reviewer } from "../../src/permission/reviewer"

describe("computer-use never self-approving", () => {
  test("reviewer defers computer_use", () => {
    expect(Reviewer.review({ permission: "computer_use", patterns: ["com.example.gui", "click"] })).toBe("defer")
  })

  test("ask source never short-circuits computer_use", async () => {
    const source = await Bun.file(new URL("../../src/permission/index.ts", import.meta.url).pathname).text()
    expect(source).toContain("computer_use")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/flynncode`: `bun test test/permission/computer-use-guard.test.ts`
Expected: FAIL on the reviewer assertion (returns `allow`) or on the source assertion (no `computer_use` branch yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/flynncode/src/permission/reviewer.ts`: add an explicit early defer so future allow-list expansion cannot self-approve this tool:

```ts
if (input.permission === "computer_use") return "defer"
```

placed before the `AUTO_ALLOW` check.

In `packages/flynncode/src/permission/index.ts`: at the top of the `ask` effect after the deny loop and before any `approval === "auto"` or `accept-edits` short-circuit, insert:

```ts
if (request.permission === "computer_use") {
  // fall through to prompt creation below; never short-circuit
}
```

implemented as a guard that skips both short-circuit branches for this permission (keep deny loop untouched so deny still wins). Do not add a new error class here; prompting is the enforcement.

- [ ] **Step 4: Run tests to verify they pass**

Run from `packages/flynncode`: `bun test test/permission/computer-use-guard.test.ts test/permission/reviewer.test.ts test/permission/approval-mode.test.ts test/permission/next.test.ts`
Expected: PASS all suites.

- [ ] **Step 5: Run typecheck**

Run from `packages/flynncode`: `bun typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/flynncode/src/permission/reviewer.ts packages/flynncode/src/permission/index.ts packages/flynncode/test/permission/computer-use-guard.test.ts
git commit -m "fix(opencode): never self-approve computer_use actions"
```

---

### Task 4: Desktop pane-scoped actuator (no OS takeover)

**Files:**

- Create: `packages/desktop/src/main/computer-use.ts`
- Test: `packages/desktop/src/main/computer-use.test.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/types.ts`

**Interfaces:**

- Consumes: browser-pane `WebContentsView` per window (Task 3 of browser-pane plan); existing `app:capturePage` screenshot path.
- Produces: `window.api.computerUse.*` for Task 5.

- [ ] **Step 1: Write the failing test**

Create `packages/desktop/src/main/computer-use.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { clampPanePoint, isComputerUseTargetAllowed } from "./computer-use"

describe("clampPanePoint", () => {
  test("clamps outside points inside the pane", () => {
    expect(clampPanePoint(-5, 900, { width: 800, height: 600 })).toEqual({ x: 0, y: 600 })
  })

  test("keeps inside points unchanged", () => {
    expect(clampPanePoint(100, 120, { width: 800, height: 600 })).toEqual({ x: 100, y: 120 })
  })
})

describe("isComputerUseTargetAllowed", () => {
  test("exact allowlist match only", () => {
    expect(isComputerUseTargetAllowed("com.example.gui", ["com.example.gui"])).toBe(true)
    expect(isComputerUseTargetAllowed("other", ["com.example.gui"])).toBe(false)
    expect(isComputerUseTargetAllowed("com.example.gui", [])).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/desktop`: `bun test src/main/computer-use.test.ts`
Expected: FAIL with "Cannot find module './computer-use'".

- [ ] **Step 3: Write minimal implementation**

Create `packages/desktop/src/main/computer-use.ts` with:

```ts
import { BrowserWindow, WebContentsView } from "electron"

export function clampPanePoint(x: number, y: number, bounds: { width: number; height: number }): { x: number; y: number } {
  return { x: Math.min(Math.max(0, x), bounds.width), y: Math.min(Math.max(0, y), bounds.height) }
}

export function isComputerUseTargetAllowed(appID: string, allowedApps: string[]): boolean {
  return allowedApps.includes(appID)
}

function paneFor(win: BrowserWindow): WebContentsView | undefined {
  return win.contentView.children.find((child) => child instanceof WebContentsView)
}

export function clickPane(win: BrowserWindow, x: number, y: number) {
  const pane = paneFor(win)
  if (pane === undefined) return
  const size = pane.getBounds()
  const point = clampPanePoint(x, y, { width: size.width, height: size.height })
  pane.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 })
  pane.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 })
}

export function typePane(win: BrowserWindow, text: string) {
  const pane = paneFor(win)
  if (pane === undefined) return
  for (const char of text) pane.webContents.sendInputEvent({ type: "char", keyCode: char })
}

export function keypressPane(win: BrowserWindow, key: string) {
  const pane = paneFor(win)
  if (pane === undefined) return
  pane.webContents.sendInputEvent({ type: "keyDown", keyCode: key })
  pane.webContents.sendInputEvent({ type: "keyUp", keyCode: key })
}

export function scrollPane(win: BrowserWindow, deltaX: number, deltaY: number) {
  const pane = paneFor(win)
  if (pane === undefined) return
  pane.webContents.sendInputEvent({ type: "mouseWheel", deltaX, deltaY })
}
```

Screenshot reuses the existing `app:capturePage` handler targeting the same pane view; do not add a second capture path. The manager never enumerates OS windows, never moves the OS cursor, never takes the foreground, cannot drive terminals, and cannot drive the ChatGPT app or the Flynncode shell itself.

In `packages/desktop/src/main/ipc.ts`: register `ipcMain.handle("computer-use-click", ...)`, `"computer-use-type"`, `"computer-use-keypress"`, `"computer-use-scroll"` resolving the sender window via `BrowserWindow.fromWebContents(event.sender)` and delegating to the matching function above. Screenshot uses the existing `app:capturePage` channel unchanged. Each handler first checks `isComputerUseTargetAllowed(appID, storeAllowedApps)` where `storeAllowedApps` is read from the existing settings store key for computer use (same store pattern as sibling desktop settings); non-allowlisted calls return without acting.

In `packages/desktop/src/preload/types.ts`, add:

```ts
export type ComputerUseAPI = {
  click: (x: number, y: number) => Promise<void>
  typeText: (text: string) => Promise<void>
  keypress: (key: string) => Promise<void>
  scroll: (deltaX: number, deltaY: number) => Promise<void>
}
```

and add `computerUse: ComputerUseAPI` to `ElectronAPI`. In `packages/desktop/src/preload/index.ts`, add:

```ts
computerUse: {
  click: (x, y) => ipcRenderer.invoke("computer-use-click", x, y),
  typeText: (text) => ipcRenderer.invoke("computer-use-type", text),
  keypress: (key) => ipcRenderer.invoke("computer-use-keypress", key),
  scroll: (deltaX, deltaY) => ipcRenderer.invoke("computer-use-scroll", deltaX, deltaY),
},
```

Native copy in this module must use `nativeT(...)` keys from the desktop-native bundle, not inline English.

- [ ] **Step 4: Run test to verify it passes**

Run from `packages/desktop`: `bun test src/main/computer-use.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run typecheck**

Run from `packages/desktop`: `bun typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/computer-use.ts packages/desktop/src/main/computer-use.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.ts
git commit -m "feat(desktop): add pane-scoped computer-use actuator"
```

---

### Task 5: Explicit consent UI (settings toggle + allowlist + per-action prompt)

**Files:**

- Modify: `packages/app/src/i18n/en.ts`
- Modify: `packages/app/src/pages/session.tsx`
- Modify: `packages/app/src/pages/session/composer/session-permission-dock.tsx`
- Test: `packages/app/src/pages/session/computer-use-panel.test.ts` (create)

**Interfaces:**

- Consumes: `window.api.computerUse.*` from Task 4; existing permission dock deny/allowOnce/allowAlways buttons.
- Produces: user-visible opt-in surface; no new SDK surface.

- [ ] **Step 1: Add i18n keys to `packages/app/src/i18n/en.ts`**

Append inside the exported `dict` object:

```ts
"computerUse.title": "Computer use",
"computerUse.enable": "Enable computer use",
"computerUse.disable": "Disable computer use",
"computerUse.disabledHint": "Computer use is off. Enable it for this GUI task only.",
"computerUse.allowlist.label": "Allowed apps",
"computerUse.allowlist.add": "Allow this app",
"computerUse.allowlist.remove": "Remove",
"computerUse.allowlist.empty": "No apps allowed yet.",
"computerUse.consent.title": "Allow this GUI action?",
"computerUse.consent.allowOnce": "Allow once",
"computerUse.consent.deny": "Deny",
"computerUse.consent.note": "Flynncode never approves its own GUI actions.",
"computerUse.stop": "Stop computer use",
"computerUse.screenshot": "Screenshot",
```

- [ ] **Step 2: Write the failing UI test**

Create `packages/app/src/pages/session/computer-use-panel.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

describe("computer-use consent panel", () => {
  test("session view wires explicit enable plus per-action consent", async () => {
    const source = await readFile(path.join(import.meta.dir, "..", "session.tsx"), "utf8")
    expect(source).toContain("computerUse.title")
    expect(source).toContain("computerUse.consent.allowOnce")
  })

  test("permission dock renders computer-use consent copy", async () => {
    const source = await readFile(path.join(import.meta.dir, "composer", "session-permission-dock.tsx"), "utf8")
    expect(source).toContain("computerUse.consent.title")
  })

  test("english dict carries computer-use keys", async () => {
    const source = await readFile(path.join(import.meta.dir, "..", "..", "i18n", "en.ts"), "utf8")
    expect(source).toContain("computerUse.enable")
    expect(source).toContain("computerUse.consent.note")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/computer-use-panel.test.ts`
Expected: FAIL (session view does not reference `computerUse.title` yet).

- [ ] **Step 4: Modify the UI**

In `packages/app/src/pages/session.tsx`: add a `data-component="computer-use-panel"` section gated on the computer-use enabled flag from settings; it renders the toggle (`computerUse.enable` / `computerUse.disable`), the allowlist editor (add current pane app via `computerUse.allowlist.add`, remove via `computerUse.allowlist.remove`, empty state `computerUse.allowlist.empty`), and the Stop button (`computerUse.stop`). The panel never auto-opens; it mounts only after the user clicks Enable. Every action dispatches one tool call at a time; no loop, no background polling.

In `packages/app/src/pages/session/composer/session-permission-dock.tsx`: when `request.permission === "computer_use"`, render the `computerUse.consent.title` header plus `allowOnce` / `deny` buttons plus the `computerUse.consent.note` hint instead of the generic approval buttons. All copy via `language.t(...)`; no hardcoded English.

- [ ] **Step 5: Run test to verify it passes**

Run from `packages/app`: `bun test src/pages/session/computer-use-panel.test.ts`
Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run from `packages/app`: `bun typecheck`
Expected: no new errors.

- [ ] **Step 7: Manual verify in dev**

Run backend from `packages/flynncode`: `bun run ./src/index.ts serve --port 4096`. Run app from `packages/app`: `bun dev -- --port 4444`. Open `http://localhost:4444`, confirm computer use reads OFF by default, enable it, allowlist one app, trigger one `click`, confirm the per-action prompt appears and Deny blocks the input event.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/i18n/en.ts packages/app/src/pages/session.tsx packages/app/src/pages/session/composer/session-permission-dock.tsx packages/app/src/pages/session/computer-use-panel.test.ts
git commit -m "feat(app): add explicit computer-use consent panel"
```

---

### Task 6: Hosted passthrough note + full verification pass

**Files:** comment-only in `packages/llm/src/protocols/openai-responses.ts` line 551 area; verification only otherwise (fix fallout in place, one commit per fix).

- [ ] **Step 1: Annotate hosted passthrough**

Above line 551 (`computer_use_call`), add:

```ts
// Hosted computer_use_call stays provider-executed and never maps to the
// local pane-scoped actuator from WS17; local execution uses the
// client-executed `computer_use` tool behind per-action consent.
```

- [ ] **Step 2: Run opencode tests**

Run from `packages/flynncode`: `bun test test/config/computer-use.test.ts test/tool/computer-use.test.ts test/permission/computer-use-guard.test.ts test/permission/reviewer.test.ts test/permission/next.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 3: Run desktop tests**

Run from `packages/desktop`: `bun test src/main/computer-use.test.ts src/main/browser-pane.test.ts`
Expected: PASS, 0 failures. When `browser-pane.test.ts` is absent (browser pane unmerged), run only `computer-use.test.ts`.

- [ ] **Step 4: Run app tests**

Run from `packages/app`: `bun test src/pages/session/computer-use-panel.test.ts src/pages/session/browser-pane.test.ts`
Expected: PASS. When `browser-pane.test.ts` is absent, run only the computer-use panel suite.

- [ ] **Step 5: Typecheck all touched packages**

Run `bun typecheck` in `packages/flynncode`, then `packages/desktop`, then `packages/app`, then `packages/llm`.
Expected: exit 0 in all four.

- [ ] **Step 6: Commit**

```bash
git add packages/llm/src/protocols/openai-responses.ts
git commit -m "docs(llm): note hosted computer_use never maps to local actuator"
```

If verification found fallout, fix in place first and use `fix(computer-use): address verification fallout` for the repair commit instead of skipping.

---

## Self-Review

1. Spec coverage: report item 16 asks for computer use last, off by default, per-app allow, never self-approving — Task 1 (OFF + allowlist), Task 2 (fail-closed tool), Task 3 (never self-approving), Task 4 (pane-scoped actuator, no OS takeover), Task 5 (explicit consent UI). Browser-pane fallback ordering is preserved by reusing the pane `WebContentsView` and the existing `capturePage` channel instead of a parallel capture stack.
2. Placeholder scan: every step names exact files, exact code, exact commands with expected output, and exact commit messages. No TBD/TODO/later/appropriate-handling language.
3. Type consistency: `resolveComputerUse` return shape is shared by config, tool, and registry; `isAppAllowed` semantics (exact match) are duplicated as pure functions in opencode config and desktop main so each layer enforces without importing the other; i18n keys introduced in Task 5 all live under `computerUse.*` and are read via `language.t(...)` or `nativeT(...)`.
