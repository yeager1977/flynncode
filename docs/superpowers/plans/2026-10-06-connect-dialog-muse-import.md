# Connect-Dialog Muse Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Import from Muse CLI" action to the Meta provider's connect/reconnect dialog that runs the `muse-opencode-auth` script through a narrow Electron IPC channel.

**Architecture:** New `packages/desktop/src/main/muse-auth.ts` module (status check + script runner via `execFile`, mirroring `background-cli.ts`) wired through the existing IPC deps pattern (`main/ipc.ts` + `main/index.ts`), exposed over the preload bridge (`preload/types.ts` + `preload/index.ts`), surfaced on the app platform context (`desktop/src/renderer/index.tsx` + `app/src/context/platform.tsx`), and consumed by `DialogConnectProvider` for `provider === "meta"` with the existing `complete()` refresh path.

**Tech Stack:** TypeScript, Electron `ipcMain.handle`/`ipcRenderer.invoke`, SolidJS dialog, `node:child_process execFile`, bun test.

## Global Constraints

- NEVER hardcode user-visible English strings in production code. ALWAYS use an i18n key; English source copy in `packages/app/src/i18n/en.ts` only, plus the fallback-module convention (`*-fallback.ts` spread into every locale) required by `parity.test.ts`.
- NEVER restart the app or the server process.
- No credential crosses IPC in either direction (status returns booleans only; sync returns the script's already-redacted stdout/stderr + exit code).
- Main resolves the script path itself (`~/.local/bin/muse-opencode-auth` first, then PATH lookup); the renderer passes NO path or command — no arbitrary execution.
- All subprocess calls carry a timeout (30s status, 120s sync).
- Repo style: `const` over `let`, early returns (no `else`), no `any`, no star imports, no import aliases.
- Commit messages: `type(scope): summary` (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`).
- Tests run from package dirs, never repo root. Typecheck via `bun typecheck` from the package dir, never `tsc`.
- Work on a short hyphenated branch (e.g. `muse-dialog-import`), not `dev`.

---

## File Structure

- Create: `packages/desktop/src/main/muse-auth.ts` — `museAuthStatus()` + `runMuseAuthSync()`, injectable runners for tests.
- Create: `packages/desktop/src/main/muse-auth.test.ts` — unit tests with tmp fixture dirs + stub executable script.
- Modify: `packages/desktop/src/main/ipc.ts` — deps entries + `ipcMain.handle("muse-auth-status" / "muse-auth-sync")`, following the `checkAppExists` deps pattern at lines ~48/82.
- Modify: `packages/desktop/src/main/index.ts` — deps wiring like line ~310.
- Modify: `packages/desktop/src/preload/types.ts` — `museAuthStatus: () => Promise<{ installed: boolean; loggedIn: boolean }>` and `museAuthSync: () => Promise<{ ok: boolean; output: string }>` (mirroring lines ~64-65).
- Modify: `packages/desktop/src/preload/index.ts` — the two invokes (mirroring `killSidecar` at line ~14).
- Modify: `packages/desktop/src/renderer/index.tsx` — platform mappings next to `checkAppExists` (~line 317).
- Modify: `packages/app/src/context/platform.tsx` — optional method types next to line ~115.
- Modify: `packages/app/src/components/dialog-connect-provider.tsx` — Meta-only import action + status query + pending/success/error states, reusing the existing `complete()` (~line 719) on success.
- Modify: `packages/app/src/i18n/en.ts` + every other locale dict + new `packages/app/src/i18n/muse-import-fallback.ts` — copy keys (same convention as `session-manage-fallback.ts`).

---

### Task 1: Main-process module + IPC + preload

**Files:**
- Create: `packages/desktop/src/main/muse-auth.ts`
- Create: `packages/desktop/src/main/muse-auth.test.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/preload/types.ts`
- Modify: `packages/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: `execFile` pattern from `background-cli.ts`; script contract from the `muse-opencode-auth` spec (exit `0` success/in-sync, non-zero failure; stdout already redacted)
- Produces (used by Task 2, exact):
  - `window.api.museAuthStatus() => Promise<{ installed: boolean; loggedIn: boolean }>`
  - `window.api.museAuthSync() => Promise<{ ok: boolean; output: string }>`
  - `platform.museAuthStatus?` / `platform.museAuthSync?` (same shapes; wired in Task 2)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findMuseAuthScript, museAuthStatus, runMuseAuthSync } from "./muse-auth"

async function stubScript(dir: string, body: string) {
  const file = join(dir, "muse-opencode-auth")
  await writeFile(file, "#!/bin/sh\n" + body + "\n")
  await chmod(file, 0o755)
  return file
}

describe("findMuseAuthScript", () => {
  test("prefers the local bin over PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-muse-"))
    try {
      const home = join(dir, "home")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(home, ".local", "bin"), { recursive: true })
      const local = await stubScript(join(home, ".local", "bin"), "exit 0")
      const found = await findMuseAuthScript({ home, pathDirs: [dir] })
      expect(found).toBe(local)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns undefined when absent everywhere", async () => {
    const found = await findMuseAuthScript({ home: "/nonexistent-home", pathDirs: [] })
    expect(found).toBeUndefined()
  })
})

describe("runMuseAuthSync", () => {
  test("returns ok and output on exit 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-muse-"))
    try {
      const script = await stubScript(dir, 'echo "OK: keys match (LLM|...len48)"')
      const result = await runMuseAuthSync({ script })
      expect(result.ok).toBe(true)
      expect(result.output).toContain("OK: keys match")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns failure on non-zero exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-muse-"))
    try {
      const script = await stubScript(dir, 'echo "FAILED"; exit 3')
      const result = await runMuseAuthSync({ script })
      expect(result.ok).toBe(false)
      expect(result.output).toContain("FAILED")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("museAuthStatus", () => {
  test("reports installed and logged in from fixture auth file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-muse-"))
    try {
      const home = join(dir, "home")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(home, ".config", "muse"), { recursive: true })
      await writeFile(
        join(home, ".config", "muse", "auth.json"),
        JSON.stringify({ providers: { meta: { api_key: "K" } } }),
      )
      const status = await museAuthStatus({ home, hasMuseBinary: async () => true })
      expect(status).toEqual({ installed: true, loggedIn: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reports logged out when the credential is absent", async () => {
    const status = await museAuthStatus({ home: "/nonexistent-home", hasMuseBinary: async () => true })
    expect(status).toEqual({ installed: true, loggedIn: false })
  })

  test("reports not installed when the binary is missing", async () => {
    const status = await museAuthStatus({ home: "/nonexistent-home", hasMuseBinary: async () => false })
    expect(status).toEqual({ installed: false, loggedIn: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/main/muse-auth.test.ts`
Expected: FAIL with "Cannot find module './muse-auth'" (run from `packages/desktop`)

- [ ] **Step 3: Write minimal implementation**

```ts
import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type MuseAuthStatus = { installed: boolean; loggedIn: boolean }
export type MuseAuthSyncResult = { ok: boolean; output: string }

type Deps = {
  home?: string
  pathDirs?: string[]
  hasMuseBinary?: () => Promise<boolean>
}

const homedir = (deps?: Deps) => deps?.home ?? process.env.HOME ?? ""
const pathDirs = (deps?: Deps) => deps?.pathDirs ?? (process.env.PATH ?? "").split(":")

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function findMuseAuthScript(deps?: Deps): Promise<string | undefined> {
  const home = homedir(deps)
  const local = home ? join(home, ".local", "bin", "muse-opencode-auth") : ""
  if (local && (await exists(local))) return local
  for (const dir of pathDirs(deps)) {
    const candidate = join(dir, "muse-opencode-auth")
    if (await exists(candidate)) return candidate
  }
  return undefined
}

async function defaultHasMuseBinary(): Promise<boolean> {
  try {
    await execFileAsync("muse", ["--version"], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

export async function museAuthStatus(deps?: Deps): Promise<MuseAuthStatus> {
  const installed = await (deps?.hasMuseBinary ?? defaultHasMuseBinary)()
  if (!installed) return { installed: false, loggedIn: false }
  try {
    const raw = await readFile(join(homedir(deps), ".config", "muse", "auth.json"), "utf8")
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== "object") return { installed: true, loggedIn: false }
    const providers = (data as { providers?: unknown }).providers
    if (!providers || typeof providers !== "object") return { installed: true, loggedIn: false }
    const meta = (providers as { meta?: unknown }).meta
    if (!meta || typeof meta !== "object") return { installed: true, loggedIn: false }
    const key = (meta as { api_key?: unknown }).api_key
    return { installed: true, loggedIn: typeof key === "string" && key.length > 0 }
  } catch {
    return { installed: true, loggedIn: false }
  }
}

export async function runMuseAuthSync(deps?: { script?: string } & Deps): Promise<MuseAuthSyncResult> {
  const script = deps?.script ?? (await findMuseAuthScript(deps))
  if (!script) return { ok: false, output: "muse-opencode-auth not found. Install it first." }
  try {
    const { stdout, stderr } = await execFileAsync(script, { timeout: 120_000 })
    return { ok: true, output: [stdout, stderr].filter(Boolean).join("\n") }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n")
    return { ok: false, output: output || "muse-opencode-auth failed." }
  }
}
```

Then wire IPC + preload (no test — covered by existing integration patterns):
- `main/ipc.ts`: add `museAuthStatus` / `museAuthSync` to the deps type (next to `checkAppExists`, ~line 48) and `ipcMain.handle("muse-auth-status", () => deps.museAuthStatus())` / `ipcMain.handle("muse-auth-sync", () => deps.museAuthSync())` (~line 82).
- `main/index.ts`: add `museAuthStatus: () => museAuthStatus()` and `museAuthSync: () => runMuseAuthSync()` to deps (~line 310).
- `preload/types.ts`: add `museAuthStatus: () => Promise<{ installed: boolean; loggedIn: boolean }>` and `museAuthSync: () => Promise<{ ok: boolean; output: string }>` (~lines 64-65).
- `preload/index.ts`: add `museAuthStatus: () => ipcRenderer.invoke("muse-auth-status")` and `museAuthSync: () => ipcRenderer.invoke("muse-auth-sync")` (~line 14).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/main/muse-auth.test.ts`
Expected: PASS (run from `packages/desktop`)

- [ ] **Step 5: Typecheck**

Run: `bun typecheck`
Expected: clean (run from `packages/desktop`)

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/muse-auth.ts packages/desktop/src/main/muse-auth.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/types.ts packages/desktop/src/preload/index.ts
git commit -m "feat(desktop): add Muse auth status and sync IPC"
```

---

### Task 2: Platform bindings + dialog UI + copy

**Files:**
- Modify: `packages/desktop/src/renderer/index.tsx`
- Modify: `packages/app/src/context/platform.tsx`
- Modify: `packages/app/src/components/dialog-connect-provider.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Create: `packages/app/src/i18n/muse-import-fallback.ts`
- Modify: every other `packages/app/src/i18n/*.ts` locale dict (import + spread only)
- Test: `packages/app/src/components/dialog-connect-provider-muse.test.ts` (source-level contract — DOM render does not work under `--conditions=solid`, same constraint as `dispatch-panel.test.tsx`)

**Interfaces:**
- Consumes (Task 1, exact): `window.api.museAuthStatus() => Promise<{ installed: boolean; loggedIn: boolean }>` and `window.api.museAuthSync() => Promise<{ ok: boolean; output: string }>`
- Produces: `platform.museAuthStatus?` / `platform.museAuthSync?` (optional — undefined on web, so the dialog gates on presence)

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const dialog = readFileSync(new URL("./dialog-connect-provider.tsx", import.meta.url), "utf8")
const platform = readFileSync(new URL("../../context/platform.tsx", import.meta.url), "utf8")
const renderer = readFileSync(
  new URL("../../../desktop/src/renderer/index.tsx", import.meta.url),
  "utf8",
)

describe("muse import action", () => {
  test("dialog gates on meta provider and platform capability", () => {
    expect(dialog).toContain('\"meta\"')
    expect(dialog).toContain("museAuthStatus")
    expect(dialog).toContain("museAuthSync")
  })

  test("dialog reuses the existing completion path on success", () => {
    expect(dialog).toContain("complete()")
  })

  test("platform declares both methods as optional", () => {
    expect(platform).toContain("museAuthStatus?")
    expect(platform).toContain("museAuthSync?")
  })

  test("renderer binds both window.api invokes", () => {
    expect(renderer).toContain("museAuthStatus")
    expect(renderer).toContain("museAuthSync")
  })

  test("copy comes from i18n keys, not hardcoded English", () => {
    expect(dialog).toContain("provider.connect.museImport")
    expect(dialog).not.toMatch(/>(Import from Muse CLI|Muse CLI)[^<]*</)
  })
})
```

(Check the relative URLs if the test file lands elsewhere: it lives at `packages/app/src/components/dialog-connect-provider-muse.test.ts`, so `../context/platform.tsx` and `../../../desktop/src/renderer/index.tsx` resolve correctly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/components/dialog-connect-provider-muse.test.ts`
Expected: FAIL (run from `packages/app`)

- [ ] **Step 3: Implement platform bindings**

In `desktop/src/renderer/index.tsx` next to `checkAppExists` (~line 317):

```ts
museAuthStatus: async () => {
  return window.api.museAuthStatus()
},

museAuthSync: async () => {
  return window.api.museAuthSync()
},
```

In `app/src/context/platform.tsx` next to line ~115:

```ts
museAuthStatus?(): Promise<{ installed: boolean; loggedIn: boolean }>
museAuthSync?(): Promise<{ ok: boolean; output: string }>
```

- [ ] **Step 4: Implement the dialog action**

In `dialog-connect-provider.tsx`, in the key-method view (near `handleSubmit`, ~line 825), for `provider().id === "meta"` only:

- On mount of the key view, if `platform.museAuthStatus` exists, query it once into local state (`{ status: "unknown" | "ready" | "unavailable", loggedIn }`). Non-desktop (`platform.museAuthStatus` undefined) renders nothing new.
- When ready and logged in: an "Import from Muse CLI" button above the paste-key form, using `language.t("provider.connect.museImport.action")`.
- When installed but logged out: a hint line with `language.t("provider.connect.museImport.loginHint")` (telling the user to run `muse login`), no button.
- Click: set pending state (disable button, show busy), `await platform.museAuthSync()`. On `{ ok: true }`: call the existing `await complete()` (same refresh + toast + close path as paste-key success, ~line 719). On `{ ok: false }`: show `result.output` (already redacted by the script) inline with a retry button using `language.t("provider.connect.museImport.retry")`.
- The `createEffect` auto-select at ~line 711 auto-picks the single method; the import action lives inside the key-method view so it appears regardless.

- [ ] **Step 5: Add copy (en + fallback + all locales)**

In `en.ts`:

```ts
"provider.connect.museImport.action": "Import from Muse CLI",
"provider.connect.museImport.loginHint": "Muse CLI is installed but not logged in. Run `muse login`, then reopen this dialog.",
"provider.connect.museImport.retry": "Retry",
"provider.connect.museImport.failed": "Import failed.",
```

Create `packages/app/src/i18n/muse-import-fallback.ts` (same shape as `session-manage-fallback.ts` — derive the four keys from the en dict by prefix `provider.connect.museImport`), and add the import + spread to every other locale dict file (same mechanical change as commit `37a8724c2b` did for 63 files).

Preserve the English text above byte-for-byte.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/components/dialog-connect-provider-muse.test.ts`
Expected: PASS (run from `packages/app`)

- [ ] **Step 7: Run parity + typecheck**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/i18n/parity.test.ts` (must pass — the fallback spread covers the new keys)
Run: `bun typecheck`
Expected: clean (both run from `packages/app`)

- [ ] **Step 8: Commit**

```bash
git add packages/desktop/src/renderer/index.tsx packages/app/src/context/platform.tsx packages/app/src/components/dialog-connect-provider.tsx packages/app/src/components/dialog-connect-provider-muse.test.ts packages/app/src/i18n/en.ts packages/app/src/i18n/muse-import-fallback.ts packages/app/src/i18n/
git commit -m "feat(app): add Muse CLI import to Meta connect dialog"
```

---

### Task 3: End-to-end verification (manual, desktop build)

**Files:** none (verification only)

- [ ] **Step 1: Build and run the desktop app locally**

Follow `packages/app/AGENTS.md` local-dev: backend from `packages/flynncode` (`bun run ./src/index.ts serve --port 4096`), app from `packages/app` (`bun dev -- --port 4444`), open `http://localhost:4444`. NEVER restart shared processes; use the documented dev servers.

- [ ] **Step 2: Import flow**

Open provider settings → Meta → Connect → "Import from Muse CLI" appears (CLI installed + logged in on this machine) → click → pending → dialog closes with connected toast → Meta shows connected without pasting a key.

- [ ] **Step 3: Failure flow**

Temporarily rename `~/.local/bin/muse-opencode-auth` aside → reopen dialog → click import → inline error + retry visible → restore the script. (Alternative if renaming is disruptive: point at a stub — but the script path is fixed, so the rename-asisde check is the honest one. Restore immediately after.)

- [ ] **Step 4: Non-Meta and web unaffected**

Open another provider's connect dialog (e.g. Anthropic) → no import action. Paste-key flow for Meta still works by typing a key.

- [ ] **Step 5: Record the outcome**

No commit. If any step fails, STOP and report back instead of proceeding.

## Self-Review

**1. Spec coverage:**
- Detection (`installed`/`loggedIn`, no secrets) → Task 1 (`museAuthStatus` + test).
- Sync contract (fixed path resolution, timeouts, redacted output, no credential over IPC) → Task 1 (`runMuseAuthSync` + test).
- Dialog UI (Meta-only action, hide/disable rule, pending/success/error, reuse `complete()`, reconnect covered by shared dialog) → Task 2.
- Copy via i18n + parity → Task 2 Steps 5/7.
- Scope (desktop-only, no server/protocol changes, exactly two invokes, no arbitrary execution) → Tasks 1–2 by construction.
- Server pickup → answered: reuse of the existing `complete()` → `refreshProviders` path; no extra refresh work.
- Manual verification table → Task 3.

**2. Placeholder scan:** no TBD/TODO; every step names exact files, line anchors, code, and commands. The 30s/120s timeouts and `~/.local/bin`-first resolution are decided values, not placeholders.

**3. Type consistency:** `museAuthStatus() => Promise<{ installed: boolean; loggedIn: boolean }>`, `museAuthSync() => Promise<{ ok: boolean; output: string }>` identical across main module, preload types, platform context, and dialog usage. i18n keys `provider.connect.museImport.action/loginHint/retry/failed` identical in test, implementation, and fallback.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-10-06-connect-dialog-muse-import.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
