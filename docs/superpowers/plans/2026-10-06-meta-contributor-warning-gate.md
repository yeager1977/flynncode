# Meta Contributor Warning Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn once per chat session with a blocking dialog whenever a Meta Muse Spark Contributor model is selected or sent to, in the desktop app.

**Architecture:** A pure detector module plus a persisted ack hook in `packages/app`; gates at the two existing choke points (`local.model.set` for selection, `createPromptSubmit.handleSubmit` for sends); a one-line log in the TUI. No server/plugin changes — verification showed both Contributor models already resolve via the models.dev `meta` catalog and no repo config change is needed.

**Tech Stack:** SolidJS + TypeScript (desktop app), i18n keys, `Persist.global` storage, `useDialog` stack, bun test.

## Global Constraints

- NEVER hardcode user-visible English strings in production code. ALWAYS use an i18n key. English source copy lives in `packages/app/src/i18n/en.ts` only.
- NEVER restart the app or the server process.
- Follow repo style: `const` over `let`, early returns (no `else`), no `any`, no star imports, no import aliases, Bun APIs where applicable.
- Tests in `packages/app`: unit via `bun test --isolate --conditions=solid --preload ./happydom.ts ./src` from `packages/app`. DOM render tests do NOT work under `--conditions=solid` (render stub throws) — pin component contracts with source-level assertions like `dispatch-panel.test.tsx` does.
- Commit messages: `type(scope): summary` with types `feat|fix|docs|chore|refactor|test`.
- Tests cannot run from repo root; run from package dirs.

---

### Task 1: Verify model availability (no code)

**Files:** none (verification only)

**Interfaces:**
- Consumes: nothing
- Produces: confirmation that both IDs resolve; feeds Task 2's ID set

- [ ] **Step 1: List models and confirm both Contributor IDs resolve**

Run: `bun run ./src/index.ts models`
Expected: output contains `meta/muse-spark-1.2-contributor` and `meta/muse-spark-1.3-contributor`
(Previously verified on this machine — re-run to confirm against the live catalog.)

- [ ] **Step 2: Confirm the router cannot route to them**

Run: `grep -rn "muse-spark" packages/flynncode/src/plugin/ollama-model-router/`
Expected: no matches (no scorecard entry, so `allowUnscored: false` excludes them).

- [ ] **Step 3: Record the outcome**

No commit (no code). If either ID is missing, STOP and report back instead of proceeding.

---

### Task 2: Detector module with unit tests

**Files:**
- Create: `packages/app/src/utils/contributor-models.ts`
- Test: `packages/app/src/utils/contributor-models.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (used by Tasks 4–8):
  - `isContributorModel(providerID: string, modelID: string): boolean`
  - `contributorModelKey(providerID: string, modelID: string): string`
  - `markContributorAcked(key: string): void`
  - `isContributorAcked(key: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { contributorModelKey, isContributorAcked, isContributorModel, markContributorAcked } from "./contributor-models"

describe("isContributorModel", () => {
  test("matches both Meta Contributor models", () => {
    expect(isContributorModel("meta", "muse-spark-1.3-contributor")).toBe(true)
    expect(isContributorModel("meta", "muse-spark-1.2-contributor")).toBe(true)
  })

  test("rejects lookalikes", () => {
    expect(isContributorModel("meta", "muse-spark-1.3")).toBe(false)
    expect(isContributorModel("meta", "muse-spark-1.3-contributor-free")).toBe(false)
    expect(isContributorModel("opencode", "muse-spark-1.3-contributor-free")).toBe(false)
    expect(isContributorModel("anthropic", "claude-sonnet-5")).toBe(false)
  })

  test("memory ack round-trips", () => {
    const key = contributorModelKey("meta", "muse-spark-1.3-contributor")
    expect(isContributorAcked("session:abc")).toBe(false)
    markContributorAcked("session:abc")
    expect(isContributorAcked("session:abc")).toBe(true)
    expect(key).toBe("meta/muse-spark-1.3-contributor")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/utils/contributor-models.test.ts`
Expected: FAIL with "Cannot find module './contributor-models'"

- [ ] **Step 3: Write minimal implementation**

```ts
const CONTRIBUTOR_MODELS = new Set([
  "meta/muse-spark-1.2-contributor",
  "meta/muse-spark-1.3-contributor",
])

export function contributorModelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

export function isContributorModel(providerID: string, modelID: string): boolean {
  return CONTRIBUTOR_MODELS.has(contributorModelKey(providerID, modelID))
}

const acked = new Set<string>()

export function isContributorAcked(key: string): boolean {
  return acked.has(key)
}

export function markContributorAcked(key: string): void {
  acked.add(key)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/utils/contributor-models.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/utils/contributor-models.ts packages/app/src/utils/contributor-models.test.ts
git commit -m "feat(app): add contributor model detector"
```

---

### Task 3: i18n keys

**Files:**
- Modify: `packages/app/src/i18n/en.ts` (near line 496, next to `dialog.usageExceeded.dontShowAgain`)

**Interfaces:**
- Consumes: nothing
- Produces (used by Task 4): `dialog.metaContributor.title`, `dialog.metaContributor.description`, `dialog.metaContributor.continue`, `dialog.metaContributor.cancel`

- [ ] **Step 1: Check for reusable common keys**

Run: `grep -n '"common.cancel"\|"common.continue"' packages/app/src/i18n/en.ts`
Expected: either both exist (reuse them, skip adding `.continue`/`.cancel`) or neither exists (add all four keys below).

- [ ] **Step 2: Add the keys (adjust per Step 1)**

```ts
"dialog.metaContributor.title": "Share data with Meta?",
"dialog.metaContributor.description": "Muse Spark Contributor models share your prompts and generated content with Meta, and Meta may use them to train future models. Only continue if you're comfortable sending this session's content and context to Meta.",
"dialog.metaContributor.continue": "Continue",
"dialog.metaContributor.cancel": "Cancel",
```

Preserve the exact English text above byte-for-byte (designer-written source copy; do not reword).

- [ ] **Step 3: Typecheck**

Run: `bun typecheck`
Expected: clean (run from `packages/app`)

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/i18n/en.ts
git commit -m "feat(app): add Meta contributor dialog copy"
```

---

### Task 4: Blocking dialog component

**Files:**
- Create: `packages/app/src/components/dialog-meta-contributor.tsx`
- Test: `packages/app/src/components/dialog-meta-contributor.test.tsx` (source-level contract — DOM render does not work under `--conditions=solid`, same constraint as `dispatch-panel.test.tsx`)

**Interfaces:**
- Consumes: Task 3 keys; `Dialog`, `Button`, `useDialog` (same imports as `dialog-usage-exceeded.tsx`); `useLanguage`
- Produces (used by Tasks 6–7):
  - `DialogMetaContributor(props: { onContinue: () => void; onCancel: () => void })`

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./dialog-meta-contributor.tsx", import.meta.url), "utf8")

describe("DialogMetaContributor", () => {
  test("renders the Meta warning copy from i18n keys", () => {
    expect(source).toContain("dialog.metaContributor.title")
    expect(source).toContain("dialog.metaContributor.description")
  })

  test("wires Continue and Cancel to caller callbacks", () => {
    expect(source).toContain("onContinue")
    expect(source).toContain("onCancel")
    expect(source).toContain("dialog.close()")
  })

  test("has no hardcoded user-visible English", () => {
    expect(source).not.toMatch(/>(Share|Continue|Cancel|Meta)[^<]*</)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/components/dialog-meta-contributor.test.tsx`
Expected: FAIL (file not found)

- [ ] **Step 3: Write the component (mirrors `dialog-usage-exceeded.tsx`)**

```tsx
import { useLanguage } from "@/context/language"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"

export function DialogMetaContributor(props: { onContinue: () => void; onCancel: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  const cancel = () => {
    props.onCancel()
    dialog.close()
  }

  const cont = () => {
    props.onContinue()
    dialog.close()
  }

  return (
    <Dialog title={language.t("dialog.metaContributor.title")} description={language.t("dialog.metaContributor.description")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={cancel}>
            {language.t("dialog.metaContributor.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={cont}>
            {language.t("dialog.metaContributor.continue")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
```

(If Step 1 of Task 3 found reusable `common.*` keys, use those for the buttons instead.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/components/dialog-meta-contributor.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/dialog-meta-contributor.tsx packages/app/src/components/dialog-meta-contributor.test.tsx
git commit -m "feat(app): add Meta contributor blocking dialog"
```

---

### Task 5: Ack hook (persisted + memory)

**Files:**
- Create: `packages/app/src/utils/contributor-ack.ts`

**Interfaces:**
- Consumes: Task 2 (`isContributorAcked`, `markContributorAcked`); `Persist`, `persisted` from `@/utils/persist` (same pattern as `usage-exceeded-dialogs.tsx`); `useSDK`, `useParams` for scope
- Produces (used by Tasks 6–7):
  - `useContributorAck(): { scopeKey(): string; acked(key: string): boolean; record(key: string): void }`
  - Scope key is the session ID when one exists, else `draft:<base64-directory>` (stable per workspace draft)

The hook owns a `persisted(Persist.global("meta-contributor-ack"), createStore<Record<string, number>>)` record (timestamp values, same shape as the go-upsell store) and keeps the Task 2 in-memory set in sync on every read/write, so multiple hook instances never stale-read within one app run and returning to a session next day still honors the ack.

- [ ] **Step 1: Write the hook**

```ts
import { useParams } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { isContributorAcked, markContributorAcked } from "./contributor-models"

export function useContributorAck() {
  const params = useParams<{ id?: string }>()
  const sdk = useSDK()

  const [store, setStore] = persisted(
    Persist.global("meta-contributor-ack"),
    createStore<Record<string, number>>({}),
  )

  const scopeKey = () => {
    if (params.id) return `session:${params.id}`
    return `draft:${base64Encode(sdk().directory)}`
  }

  const acked = (key: string) => {
    if (isContributorAcked(key)) return true
    if (!store[key]) return false
    markContributorAcked(key)
    return true
  }

  const record = (key: string) => {
    markContributorAcked(key)
    setStore(key, Date.now())
  }

  return { scopeKey, acked, record }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun typecheck`
Expected: clean (run from `packages/app`; fix the `persisted` call signature against `usage-exceeded-dialogs.tsx:43-51` if it differs)

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/utils/contributor-ack.ts
git commit -m "feat(app): add persisted contributor ack hook"
```

---

### Task 6: Selection gate

**Files:**
- Modify: `packages/app/src/context/local.tsx` (`model.set`, ~line 306)
- Modify: `packages/app/src/pages/session/composer/prompt-model-selection.ts` (`selection.set`, ~line 67)
- Modify: `packages/app/src/pages/session/session-model-helpers.ts` (add `silent` option to programmatic restores)
- Test: `packages/app/src/pages/session/contributor-gate.test.ts` (source-level contract)

**Interfaces:**
- Consumes: Tasks 2, 4, 5; `useDialog` (safe: `LocalProvider` always renders under `DialogProvider` in `app.tsx:422`); `queueMicrotask` defer so the model-picker dialog closes before the confirm dialog mounts (`dialog.show` clears the stack — mounting synchronously from the picker's `onSelect` would have the picker's own `close()` kill the confirm dialog)
- Produces: gated `set` on both `ModelSelection` implementations; `silent` restore path that never dialogs

Gate logic (identical in both `set` implementations):

```ts
set(item, options) {
  if (item && !options?.silent && isContributorModel(item.providerID, item.modelID) && !ack.acked(ack.scopeKey())) {
    const pending = { ...item }
    queueMicrotask(() => {
      dialog.show(
        () => (
          <DialogMetaContributor
            onContinue={() => {
              ack.record(ack.scopeKey())
              applySet(pending, options)
            }}
            onCancel={() => {}}
          />
        ),
        () => {},
      )
    })
    return
  }
  applySet(item, options)
}
```

where `applySet` is the existing `set` body verbatim. The second `dialog.show` argument is `onClose` — Escape/overlay dismissal resolves as Cancel (do nothing), so the promise-free flow fails closed. Cancel leaves every existing side effect (`write`, visibility, recent) unrun: selection unchanged.

`session-model-helpers.ts`: `syncPromptModel` and `restorePromptModel` call `set` during session restore — add `{ silent: true }` to those two call sites only. Picker/cycle calls keep the default (gated).

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const local = readFileSync(new URL("../../context/local.tsx", import.meta.url), "utf8")
const selection = readFileSync(new URL("./composer/prompt-model-selection.ts", import.meta.url), "utf8")
const helpers = readFileSync(new URL("./session-model-helpers.ts", import.meta.url), "utf8")

describe("contributor selection gate", () => {
  test("both ModelSelection.set implementations gate Contributor models", () => {
    for (const source of [local, selection]) {
      expect(source).toContain("isContributorModel")
      expect(source).toContain("DialogMetaContributor")
      expect(source).toContain("queueMicrotask")
    }
  })

  test("Cancel path applies no selection side effects", () => {
    expect(local).toContain("onCancel={() => {}}")
  })

  test("programmatic restores bypass the dialog", () => {
    expect(helpers).toContain("silent: true")
    expect(local).toContain("silent")
    expect(selection).toContain("silent")
  })
})
```

(Adjust the relative URL if the test file lands elsewhere: it lives at `packages/app/src/pages/session/contributor-gate.test.ts`, so `../../context/local.tsx`, `./composer/prompt-model-selection.ts`, and `./session-model-helpers.ts` resolve correctly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/session/contributor-gate.test.ts`
Expected: FAIL (no `isContributorModel` in sources)

- [ ] **Step 3: Implement the gate in both files + `silent` in helpers**

Apply the gate logic above. In `local.tsx`, obtain `dialog = useDialog()` and `ack = useContributorAck()` in the `init` closure next to the existing `useModels()`/`useSDK()` calls. In `prompt-model-selection.ts`, obtain both in `createPromptModelSelection` next to `useSDK()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/session/contributor-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `bun typecheck`
Expected: clean (run from `packages/app`)

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/context/local.tsx packages/app/src/pages/session/composer/prompt-model-selection.ts packages/app/src/pages/session/session-model-helpers.ts packages/app/src/pages/session/contributor-gate.test.ts
git commit -m "feat(app): gate contributor model selection"
```

---

### Task 7: Submit gate

**Files:**
- Modify: `packages/app/src/components/prompt-input/submit.ts` (`handleSubmit`, immediately after the `currentModel`/`currentAgent` null check at ~line 342, before `input.addToHistory`)
- Test: extend `packages/app/src/pages/session/contributor-gate.test.ts` with a submit-gate case

**Interfaces:**
- Consumes: Tasks 2, 4, 5; existing `restoreInput` machinery is NOT needed — the gate sits before `clearInput()`, so Cancel is a bare `return` with the prompt text untouched

Gate logic (insert after the `modelAgentRequired` toast block):

```ts
if (isContributorModel(currentModel.provider.id, currentModel.id) && !ack.acked(ack.scopeKey())) {
  const proceed = await new Promise<boolean>((resolve) => {
    queueMicrotask(() => {
      dialog.show(
        () => (
          <DialogMetaContributor
            onContinue={() => {
              ack.record(ack.scopeKey())
              resolve(true)
            }}
            onCancel={() => resolve(false)}
          />
        ),
        () => resolve(false),
      )
    })
  })
  if (!proceed) return
}
```

`createPromptSubmit` needs `dialog = useDialog()` and `ack = useContributorAck()` next to its existing context calls. New-session draft→session migration: after the `if (!session) { … return }` guard (~line 442, where `session` is narrowed to defined), add:

```ts
if (isContributorModel(currentModel.provider.id, currentModel.id)) {
  ack.record(`session:${session.id}`)
}
```

so the first send records the session ack (the pre-creation check ran against the draft scope). Queued (`onQueue`), shell, and custom-command sends all flow through `handleSubmit` before their branches, so they are gated at the same point. `sendFollowupDraft`'s direct caller (`session.tsx` followup mutation) re-sends drafts whose models were fixed at queue time in `handleSubmit` — no separate gate needed.

- [ ] **Step 1: Extend the contract test with the submit case**

```ts
test("submit gate blocks send before input is cleared", () => {
  const submit = readFileSync(
    new URL("../../components/prompt-input/submit.ts", import.meta.url),
    "utf8",
  )
  expect(submit).toContain("isContributorModel")
  expect(submit).toContain("DialogMetaContributor")
  const gateAt = submit.indexOf("isContributorModel")
  const clearAt = submit.indexOf("clearInput()")
  expect(gateAt).toBeGreaterThan(-1)
  expect(clearAt).toBeGreaterThan(-1)
  expect(gateAt).toBeLessThan(clearAt)
})

test("new sessions migrate the ack to the created session ID", () => {
  const submit = readFileSync(
    new URL("../../components/prompt-input/submit.ts", import.meta.url),
    "utf8",
  )
  expect(submit).toContain("`session:${session.id}`")
})
```

- [ ] **Step 2: Run test to verify the new cases fail**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/session/contributor-gate.test.ts`
Expected: FAIL on the two new cases

- [ ] **Step 3: Implement the submit gate + migration**

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/session/contributor-gate.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Typecheck**

Run: `bun typecheck`
Expected: clean (run from `packages/app`)

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/components/prompt-input/submit.ts packages/app/src/pages/session/contributor-gate.test.ts
git commit -m "feat(app): gate contributor model sends"
```

---

### Task 8: TUI log line

**Files:**
- Modify: `packages/tui/src/component/prompt/index.tsx` (after the `selectedModel` null check at ~line 968)

**Interfaces:**
- Consumes: Task 2's ID set, duplicated inline (the TUI cannot import from `packages/app`; leave a comment pointing at `packages/app/src/utils/contributor-models.ts` as the canonical list)

```ts
// Canonical list: packages/app/src/utils/contributor-models.ts
const contributorLogged = new Set<string>()
if (
  selectedModel.providerID === "meta" &&
  (selectedModel.modelID === "muse-spark-1.2-contributor" ||
    selectedModel.modelID === "muse-spark-1.3-contributor")
) {
  const key = props.sessionID ?? "draft"
  if (!contributorLogged.has(key)) {
    contributorLogged.add(key)
    console.log(
      "Warning: Muse Spark Contributor models share your prompts and generated content with Meta for training future models.",
    )
  }
}
```

- [ ] **Step 1: Add the log line**

- [ ] **Step 2: Run TUI tests**

Run: `bun test --timeout 30000 --only-failures`
Expected: PASS (run from `packages/tui`)

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/component/prompt/index.tsx
git commit -m "feat(tui): log Meta contributor data-sharing warning"
```

---

### Task 9: Subscription credential verification (manual, no code)

**Files:** none

- [ ] **Step 1: Complete `muse` onboarding on a machine with the CLI**

Run: `muse` → choose "Sign in with your browser" (MMA accounts must use "Paste an API key" instead).

- [ ] **Step 2: Locate the stored subscription credential**

Inspect the Muse CLI's local storage for the auto-connected credential from onboarding (exact path confirmed at implementation time — no `muse` CLI exists on this machine).

- [ ] **Step 3: Install it as opencode's `meta` key**

Paste it into the connect-provider dialog for Meta, or set `META_MODEL_API_KEY`. Verify `bun run ./src/index.ts models` (from `packages/flynncode`) still lists both Contributor IDs, and confirm a Contributor model is selectable in the desktop picker.

- [ ] **Step 4: Record the outcome**

No commit. Caveats from the spec stand: Meta states the subscription credential is for Muse Code only (user accepts the risk); an exported `META_API_KEY`/`META_MODEL_API_KEY` takes priority over and can hide a stored browser session.

---

### Task 10: Manual browser verification

**Files:** none (verification only — desktop app must already be running; NEVER restart it)

- [ ] **Step 1: Picker gate**

Select `meta/muse-spark-1.3-contributor` in the model picker → blocking dialog appears → Cancel keeps the previous model; Continue applies it.

- [ ] **Step 2: No re-warn in-session**

With the model active, send two prompts → no dialog on either (selection ack covers the session).

- [ ] **Step 3: Switch-away-and-back**

Switch to another model, then back to the Contributor → no dialog (session ack is model-agnostic).

- [ ] **Step 4: New session re-warns**

Open a new chat with the Contributor as the default model → dialog appears at first send; Cancel leaves the prompt text intact in the composer.

- [ ] **Step 5: Non-contributor untouched**

Select `meta/muse-spark-1.3` (non-contributor) and send → no dialog, ever.

## Self-Review

**1. Spec coverage:**
- Model availability → Task 1 (verify; no config change needed per live catalog check).
- Detector module → Task 2.
- Dialog component + i18n → Tasks 3–4.
- Selection gate → Task 6 (both `set` implementations, `silent` restores).
- Submit gate + once-per-session + draft migration → Tasks 5, 7.
- TUI log line → Task 8.
- Subscription credential reuse → Task 9.
- Router exclusion → Task 1 Step 2 (verified, no code).
- `small_model`/subagents ungated → by construction (gates only touch composer selection + submit).
- Manual verification table → Task 10.

**2. Placeholder scan:** no TBD/TODO/"implement later"; every step names exact files, code, and commands. The one intentional runtime discovery (Muse CLI credential path, Task 9 Step 2) is a manual step on a machine with the CLI, not a code placeholder.

**3. Type consistency:** `isContributorModel(providerID, modelID)` / `contributorModelKey` / `isContributorAcked` / `markContributorAcked` keep identical names and shapes from Task 2 through Tasks 5–8. `DialogMetaContributor({ onContinue, onCancel })` props match all call sites. `useContributorAck()` returns `{ scopeKey, acked, record }` everywhere.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-10-06-meta-contributor-warning-gate.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
