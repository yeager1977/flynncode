# Computer History (WS16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-session, local-only activity history tab that answers what ran, what changed, and what was approved from the existing event log.

**Architecture:** A pure client-side deriver turns already-fetched session messages, diff infos, and stored artifacts into a chronological, text-queryable entry list rendered in a new SessionSidePanel section; an explicit per-session localStorage consent flag gates only pixel attachments, never the text timeline.

**Tech Stack:** SolidJS + TypeScript in `packages/app`, Bun test runner, existing app i18n dictionary (`language.t`), existing session export/diff/artifact stores.

## Global Constraints

- History is derived from existing events, never a new recorder: consume `SessionExportData["messages"]`, `FileDiffInfo[]`, and `StoredArtifact[]` only.
- History stays on disk locally and is never uploaded: no new network calls except the existing session get/messages/diff reads; export writes a local JSON download only.
- No screen recording and no pixel capture without explicit per-session consent: text entries always render; screenshot artifacts render only when consent is on.
- All visible copy uses `language.t(...)` with keys added to `packages/app/src/i18n/en.ts` only (en source copy; other locales fall back).
- No `any` type in new or touched code.
- No star imports (`import * as`) and no aliased imports (`import { foo as bar }`).
- Prefer `const` over `let`, early returns over `else`, dot notation over destructuring, and `Bun.file()` for file reads in scripts.
- Run app unit tests with `bun test <path>` and `bun typecheck` from `packages/app`; never run tests from repo root.
- Branch from `dev` with a short hyphenated name of at most three words (example: `computer-history`); commit style `type(scope): summary`.

---

### Task 1: Derive history entries from existing events

**Files:**
- Create: `packages/app/src/pages/session/history/session-history.ts`
- Create: `packages/app/src/pages/session/history/session-history.test.ts`

**Interfaces:**
- Consumes: `SessionExportData["messages"]` from `packages/app/src/utils/session-export.ts`, `FileDiffInfo` from `@opencode-ai/client/promise`, `StoredArtifact` from `packages/app/src/pages/layout/sidebar-artifacts.ts`.
- Produces: `deriveSessionHistory(input: HistoryInput): HistoryEntry[]` and `filterHistoryEntries(entries: readonly HistoryEntry[], query: string): HistoryEntry[]`, used by Task 4 panel.

```ts
export type HistoryEntryKind = "run" | "change" | "approval" | "note"
export type HistoryEntry = {
  id: string
  time: number
  kind: HistoryEntryKind
  title: string
  detail: string
  sessionID: string
  file?: string
}
export type HistoryInput = {
  sessionID: string
  messages: SessionExportData["messages"]
  diffs: FileDiffInfo[]
  stored: StoredArtifact[]
}
```

Entry rules (locked here, tested below): every completed or errored `tool` part with `tool === "bash"` becomes one `run` entry titled with the command summary; every `edit`, `write`, or `apply_patch` tool part becomes one `change` entry with `file` set from the part input; every tool part whose input metadata carries `permissionAsked === true` or whose state metadata carries `interrupted === true` also yields one `approval` entry; every `FileDiffInfo` not already covered by a `change` entry yields one `change` entry; every stored `note` artifact yields one `note` entry; stored `screenshot` artifacts are excluded here and re-added by the panel only under consent (Task 2 + Task 4).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { deriveSessionHistory, filterHistoryEntries } from "./session-history"

function toolMessage(id: string, tool: string, input: Record<string, string>, status: string) {
  return {
    info: { id, role: "assistant", sessionID: "ses_1", time: { created: 10, updated: 10 } },
    parts: [{ type: "tool", tool, callID: `call_${id}`, state: { status, input, output: "ok" } }],
  }
}

describe("deriveSessionHistory", () => {
  test("maps bash runs, file changes, and notes in time order", () => {
    const entries = deriveSessionHistory({
      sessionID: "ses_1",
      messages: [
        toolMessage("m1", "bash", { command: "bun test" }, "completed"),
        toolMessage("m2", "edit", { file: "src/a.ts" }, "completed"),
      ],
      diffs: [{ file: "src/b.ts", additions: 2, deletions: 1 }],
      stored: [{ id: "art_1", type: "note", sessionID: "ses_1", text: "ship it", created: 30 }],
    })
    expect(entries.map((entry) => entry.kind)).toEqual(["run", "change", "change", "note"])
    expect(entries[0].detail).toContain("bun test")
    expect(entries[1].file).toBe("src/a.ts")
  })

  test("filters by text query across title, detail, and file", () => {
    const entries = deriveSessionHistory({
      sessionID: "ses_1",
      messages: [toolMessage("m1", "bash", { command: "bun test" }, "completed")],
      diffs: [],
      stored: [],
    })
    expect(filterHistoryEntries(entries, "bun").length).toBe(1)
    expect(filterHistoryEntries(entries, "zzz").length).toBe(0)
    expect(filterHistoryEntries(entries, "").length).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/pages/session/history/session-history.test.ts`
Expected: FAIL with "Cannot find module './session-history'"

- [ ] **Step 3: Write the minimal deriver**

```ts
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { SessionExportData } from "@/utils/session-export"
import type { StoredArtifact } from "@/pages/layout/sidebar-artifacts"

export type HistoryEntryKind = "run" | "change" | "approval" | "note"

export type HistoryEntry = {
  id: string
  time: number
  kind: HistoryEntryKind
  title: string
  detail: string
  sessionID: string
  file?: string
}

export type HistoryInput = {
  sessionID: string
  messages: SessionExportData["messages"]
  diffs: FileDiffInfo[]
  stored: StoredArtifact[]
}

function toolFile(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const record = input as Record<string, unknown>
  const file = record.file
  if (typeof file === "string" && file.length > 0) return file
  const path = record.path
  if (typeof path === "string" && path.length > 0) return path
  return undefined
}

function toolCommand(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  const record = input as Record<string, unknown>
  const command = record.command
  return typeof command === "string" ? command : JSON.stringify(input).slice(0, 200)
}

function messageTime(message: SessionExportData["messages"][number], fallback: number): number {
  const created = message.info.time.created
  return typeof created === "number" ? created : fallback
}

export function deriveSessionHistory(input: HistoryInput): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  const changed = new Set<string>()
  input.messages.forEach((message, index) => {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      const tool = part.tool
      const state = part.state
      if (state.status !== "completed" && state.status !== "error") continue
      const time = messageTime(message, index)
      if (tool === "bash") {
        const command = toolCommand(state.input)
        entries.push({
          id: `run-${message.info.id}-${part.callID}`,
          time,
          kind: "run",
          title: `Ran ${command.slice(0, 80)}`,
          detail: command,
          sessionID: input.sessionID,
        })
      }
      if (tool === "edit" || tool === "write" || tool === "apply_patch") {
        const file = toolFile(state.input) ?? "unknown file"
        changed.add(file)
        entries.push({
          id: `change-${message.info.id}-${part.callID}`,
          time,
          kind: "change",
          title: `Changed ${file}`,
          detail: `${tool} ${file}`,
          sessionID: input.sessionID,
          file,
        })
      }
      const metadata = (state.metadata ?? {}) as Record<string, unknown>
      if (metadata.permissionAsked === true || metadata.interrupted === true) {
        entries.push({
          id: `approval-${message.info.id}-${part.callID}`,
          time,
          kind: "approval",
          title: `Approval for ${tool}`,
          detail: metadata.interrupted === true ? "Interrupted, needs decision" : "Asked and decided",
          sessionID: input.sessionID,
          file: toolFile(state.input),
        })
      }
    }
  })
  for (const diff of input.diffs) {
    if (changed.has(diff.file)) continue
    entries.push({
      id: `diff-${diff.file}`,
      time: 0,
      kind: "change",
      title: `Changed ${diff.file}`,
      detail: `+${diff.additions} -${diff.deletions}`,
      sessionID: input.sessionID,
      file: diff.file,
    })
  }
  for (const artifact of input.stored) {
    if (artifact.sessionID !== input.sessionID) continue
    if (artifact.type !== "note") continue
    entries.push({
      id: artifact.id,
      time: artifact.created,
      kind: "note",
      title: "Note",
      detail: artifact.text,
      sessionID: input.sessionID,
      file: artifact.file,
    })
  }
  entries.sort((a, b) => a.time - b.time)
  return entries
}

export function filterHistoryEntries(entries: readonly HistoryEntry[], query: string): HistoryEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...entries]
  return entries.filter((entry) => {
    return `${entry.title}\n${entry.detail}\n${entry.file ?? ""}`.toLowerCase().includes(needle)
  })
}
```

Keep helpers (`toolFile`, `toolCommand`, `messageTime`) non-exported in this file. Do not import `StoredArtifact` screenshot handling here.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/pages/session/history/session-history.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/history/session-history.ts packages/app/src/pages/session/history/session-history.test.ts
git commit -m "feat(app): derive per-session history from event log"
```

### Task 2: Per-session pixel consent gate

**Files:**
- Create: `packages/app/src/pages/session/history/history-consent.ts`
- Create: `packages/app/src/pages/session/history/history-consent.test.ts`

**Interfaces:**
- Consumes: browser `localStorage` only.
- Produces: `loadHistoryConsent(sessionID: string): boolean`, `saveHistoryConsent(sessionID: string, consented: boolean): void`, and `historyConsentKey(sessionID: string): string`, used by Task 4 to decide whether screenshot artifacts may appear.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { historyConsentKey, loadHistoryConsent, saveHistoryConsent } from "./history-consent"

describe("history consent", () => {
  test("defaults to off and round-trips per session", () => {
    expect(historyConsentKey("ses_1")).toBe("opencode.session-history.consent.ses_1")
    expect(loadHistoryConsent("ses_test_default_off")).toBe(false)
    saveHistoryConsent("ses_test_roundtrip", true)
    expect(loadHistoryConsent("ses_test_roundtrip")).toBe(true)
    saveHistoryConsent("ses_test_roundtrip", false)
    expect(loadHistoryConsent("ses_test_roundtrip")).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/pages/session/history/history-consent.test.ts`
Expected: FAIL with "Cannot find module './history-consent'"

- [ ] **Step 3: Write the minimal consent store**

```ts
const PREFIX = "opencode.session-history.consent."

export function historyConsentKey(sessionID: string): string {
  return `${PREFIX}${sessionID}`
}

export function loadHistoryConsent(sessionID: string): boolean {
  if (typeof localStorage !== "object") return false
  return localStorage.getItem(historyConsentKey(sessionID)) === "1"
}

export function saveHistoryConsent(sessionID: string, consented: boolean): void {
  if (typeof localStorage !== "object") return
  if (consented) localStorage.setItem(historyConsentKey(sessionID), "1")
  else localStorage.removeItem(historyConsentKey(sessionID))
}
```

Default is off because the key is absent. Consent is per session ID and removable, so pixels never leak across sessions.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/pages/session/history/history-consent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/history/history-consent.ts packages/app/src/pages/session/history/history-consent.test.ts
git commit -m "feat(app): gate history pixels behind per-session consent"
```

### Task 3: English i18n copy for history

**Files:**
- Modify: `packages/app/src/i18n/en.ts` (append `history.*` keys near the `sidebar.artifacts.*` block at line 974)

**Interfaces:**
- Consumes: nothing new.
- Produces: `history.title`, `history.search.placeholder`, `history.consent.title`, `history.consent.description`, `history.consent.enable`, `history.consent.disable`, `history.empty`, `history.export`, `history.kind.run`, `history.kind.change`, `history.kind.approval`, `history.kind.note`, used by Task 4 via `language.t(...)`.

- [ ] **Step 1: Add the keys**

```ts
"history.title": "Activity",
"history.search.placeholder": "Filter activity",
"history.consent.title": "Screenshots are off",
"history.consent.description": "Text history stays on this device. Turn on screenshots for this session to attach pixels.",
"history.consent.enable": "Show screenshots for this session",
"history.consent.disable": "Hide screenshots",
"history.empty": "No activity yet. Runs, file changes, and approvals will appear here.",
"history.export": "Export history",
"history.kind.run": "Ran",
"history.kind.change": "Changed",
"history.kind.approval": "Approval",
"history.kind.note": "Note",
```

Preserve existing English byte-for-byte; only append these keys. En-only by design; other locales use the existing fallback path.

- [ ] **Step 2: Verify parity fallback still resolves**

Run: `bun test src/i18n/parity.test.ts`
Expected: PASS (sidebar/history fallback shape unchanged for non-en locales)

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/i18n/en.ts
git commit -m "feat(app): add activity history copy"
```

### Task 4: History panel with text-first query and consented pixels

**Files:**
- Create: `packages/app/src/pages/session/history/session-history-panel.tsx`
- Create: `packages/app/src/pages/session/history/session-history-panel.test.ts`

**Interfaces:**
- Consumes: `deriveSessionHistory` and `filterHistoryEntries` from Task 1, `loadHistoryConsent` and `saveHistoryConsent` from Task 2, `SessionDiffData` and `StoredArtifact` from `packages/app/src/pages/layout/sidebar-artifacts.ts`, `SessionExportData` from `packages/app/src/utils/session-export.ts`.
- Produces: `SessionHistoryPanel(props: { sessionID: string; messages: SessionExportData["messages"]; diffs: FileDiffInfo[]; stored: StoredArtifact[] }): JSX.Element` rendered by Task 5.

Panel behavior: text input filters with `filterHistoryEntries`; list rows show kind label via `language.t("history.kind.run")` etc.; screenshot `StoredArtifact` rows render only when `loadHistoryConsent(sessionID)` is true, behind the enable/disable toggle that calls `saveHistoryConsent`; Export button downloads `history.json` with `URL.createObjectURL`, local-only.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("SessionHistoryPanel", () => {
  test("uses i18n keys and consent gate, never hardcodes copy", () => {
    const source = readFileSync(new URL("./session-history-panel.tsx", import.meta.url), "utf8")
    expect(source).toContain('language.t("history.title")')
    expect(source).toContain('language.t("history.search.placeholder")')
    expect(source).toContain('language.t("history.consent.enable")')
    expect(source).toContain("loadHistoryConsent")
    expect(source).toContain("filterHistoryEntries")
    expect(source).not.toContain("Screenshot")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/pages/session/history/session-history-panel.test.ts`
Expected: FAIL with "Cannot find module './session-history-panel.tsx'" or missing-file read error

- [ ] **Step 3: Write the minimal panel**

```tsx
import { createMemo, createSignal } from "solid-js"
import { For } from "solid-js"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { language } from "@/i18n/language"
import { deriveSessionHistory, filterHistoryEntries } from "@/pages/session/history/session-history"
import { loadHistoryConsent, saveHistoryConsent } from "@/pages/session/history/history-consent"
import type { StoredArtifact } from "@/pages/layout/sidebar-artifacts"
import type { SessionExportData } from "@/utils/session-export"

export function SessionHistoryPanel(props: {
  sessionID: string
  messages: SessionExportData["messages"]
  diffs: FileDiffInfo[]
  stored: StoredArtifact[]
}) {
  const [query, setQuery] = createSignal("")
  const [consented, setConsented] = createSignal(loadHistoryConsent(props.sessionID))
  const entries = createMemo(() => {
    const base = deriveSessionHistory({
      sessionID: props.sessionID,
      messages: props.messages,
      diffs: props.diffs,
      stored: props.stored,
    })
    const visible = props.stored.filter((artifact) => {
      if (artifact.sessionID !== props.sessionID) return false
      if (artifact.type !== "screenshot") return false
      return consented()
    })
    const withPixels = [
      ...base,
      ...visible.map((artifact) => ({
        id: artifact.id,
        time: artifact.created,
        kind: "note" as const,
        title: language.t("history.kind.note"),
        detail: artifact.note ?? artifact.url,
        sessionID: props.sessionID,
      })),
    ]
    withPixels.sort((a, b) => a.time - b.time)
    return filterHistoryEntries(withPixels, query())
  })

  function toggleConsent() {
    const next = !consented()
    setConsented(next)
    saveHistoryConsent(props.sessionID, next)
  }

  function exportHistory() {
    const blob = new Blob([JSON.stringify(entries(), null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `history-${props.sessionID}.json`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  return (
    <section aria-label={language.t("history.title")}>
      <input
        type="search"
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
        placeholder={language.t("history.search.placeholder")}
        aria-label={language.t("history.search.placeholder")}
      />
      <button type="button" onClick={toggleConsent}>
        {consented() ? language.t("history.consent.disable") : language.t("history.consent.enable")}
      </button>
      <button type="button" onClick={exportHistory}>
        {language.t("history.export")}
      </button>
      <ul>
        <For each={entries()} fallback={<li>{language.t("history.empty")}</li>}>
          {(entry) => (
            <li>
              <span>{language.t(`history.kind.${entry.kind}`)}</span> <span>{entry.title}</span>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}
```

No hardcoded visible English; kind labels resolve through `history.kind.*`. Pixel rows only exist when `consented()` is true. Export stays on device via object URL download.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/pages/session/history/session-history-panel.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/history/session-history-panel.tsx packages/app/src/pages/session/history/session-history-panel.test.ts
git commit -m "feat(app): add queryable session history panel"
```

### Task 5: Mount history beside changed files

**Files:**
- Modify: `packages/app/src/pages/session/session-side-panel.tsx` (add History section below the artifacts group, reusing `SessionDiffData` + `loadStoredArtifacts` inputs already present in that file)
- Modify: `packages/app/src/pages/session/session-side-panel.test.ts` (create if absent; assert History mounts without changing artifact grouping)

**Interfaces:**
- Consumes: `SessionHistoryPanel` from Task 4.
- Produces: visible History section in the session sidebar; no change to `groupSessionArtifacts` behavior.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("SessionSidePanel history", () => {
  test("mounts history panel with existing diff inputs", () => {
    const source = readFileSync(new URL("./session-side-panel.tsx", import.meta.url), "utf8")
    expect(source).toContain("SessionHistoryPanel")
    expect(source).toContain("groupSessionArtifacts")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/pages/session/session-side-panel.test.ts`
Expected: FAIL (missing `SessionHistoryPanel` in source, or missing test file)

- [ ] **Step 3: Wire the panel**

```tsx
import { SessionHistoryPanel } from "@/pages/session/history/session-history-panel"
```

Render below the existing artifacts group list inside `SessionSidePanel`, passing the same `sessionID`, the already-loaded `messages`, `Object.values(store.session_diff).flat()`, and `loadStoredArtifacts(directory)`:

```tsx
<SessionHistoryPanel sessionID={props.sessionID} messages={messages()} diffs={diffs()} stored={stored()} />
```

Derive `diffs()` with `createMemo(() => Object.values(store.session_diff).flat())` and `stored()` with `createMemo(() => loadStoredArtifacts(props.directory))` next to the existing `groupSessionArtifacts` call. Do not alter artifact grouping, filter keys, or tab order.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/pages/session/session-side-panel.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/session-side-panel.tsx packages/app/src/pages/session/session-side-panel.test.ts
git commit -m "feat(app): mount session history beside changed files"
```

### Task 6: Verify types, tests, and local UI

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the app package**

Run: `bun typecheck`
Workdir: `packages/app`
Expected: clean, no errors.

- [ ] **Step 2: Run the history test set**

Run: `bun test src/pages/session/history/ src/pages/session/session-side-panel.test.ts src/i18n/parity.test.ts`
Workdir: `packages/app`
Expected: all PASS.

- [ ] **Step 3: Verify in local UI**

Run backend from `packages/flynncode` with `bun run ./src/index.ts serve --port 4096`, then app from `packages/app` with `bun dev -- --port 4444`, open `http://localhost:4444`, open any session, confirm the Activity section lists runs/changes/approvals, text filter narrows rows, screenshots stay hidden until the per-session toggle, and Export downloads `history-<sessionID>.json`. Never restart shared app/server processes; use the separate ports above.
