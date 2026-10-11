# Review Return Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the review supervision loop so last-turn diffs carry per-hunk stage/unstage/revert, inline comments convert to the next turn in one action, and `/review` offers base-branch/uncommitted/commit presets with detached-chat delivery.

**Architecture:** Keep the existing scope model (`git`/`branch`/`turn` via `sessionReviewMode`, `turnDiffs` from the last user message summary) and the existing `vcs.apply` endpoint; add a pure per-hunk patch splitter consumed by both review panels, move `reviewFollowUp` headers behind i18n keys, and add a pure `/review` preset-arg builder plus a fork-and-prefill detached path that reuses the existing `session.fork` API.

**Tech Stack:** SolidJS (packages/app, packages/session-ui), Effect v4 service conventions (packages/flynncode command module), existing generated SDK (`sdk().client.vcs.apply`, `sdk().client.session.fork`), `bun:test`, `bun typecheck`.

## Global Constraints

- Product is Flynncode, not upstream opencode.
- Backends are self-hosted or user-owned only; vendor-hosted clouds, Sites hosting, and voice products stay OUT of this plan.
- NEVER hardcode user-visible English strings in production code; every new label goes behind an i18n key in `packages/app/src/i18n/en.ts` (other locales fall back to English source).
- Never use the `any` type.
- Never alias imports and never use star imports; import the module's own exported namespace by name where a namespace is needed.
- Rely on type inference; avoid explicit annotations unless needed for exports or clarity.
- Prefer `const` over `let`; prefer early returns over `else`.
- Run tests from package directories (for example `packages/app`), never from the repo root.
- Run `bun typecheck` from the touched package directory before committing.
- Do not restart the app or server processes.
- Hunk revert reverses the patch client-side and calls `vcs.apply` with `index` omitted; it must never call the message-level `session.revert` API.
- `/review` presets must never mutate the working tree; the reviewer prompt is read-only by construction.

---

### Files to create, modify, and test

**Create:**

- `packages/app/src/pages/session/split-patch.ts` — pure per-hunk unified-diff splitter.
- `packages/app/src/pages/session/split-patch.test.ts` — splitter unit tests.
- `packages/app/src/pages/session/review-detached.ts` — pure detached-review prompt/prefill-key builders.
- `packages/app/src/pages/session/review-detached.test.ts` — detached builder unit tests.
- `packages/flynncode/src/command/review-preset.ts` — pure `/review` preset-arg builder.
- `packages/flynncode/test/command/review-preset.test.ts` — preset-arg unit tests.

**Modify:**

- `packages/app/src/pages/session/review-follow-up.ts` — accept a caller-supplied translated header instead of hardcoded English.
- `packages/app/src/pages/session/review-follow-up.test.ts` — pass an explicit header; assert header passthrough.
- `packages/app/src/i18n/en.ts` — add `session.review.followUp.turn`, `session.review.followUp.git`, `session.review.followUp.branch`, `session.review.reviewPreset.*`, `session.review.detached.*`, `session.review.hunk.*` keys as needed.
- `packages/app/src/pages/session.tsx` — pass translated follow-up headers, disable address-comments with zero comments, add detached toggle wiring.
- `packages/app/src/pages/session/v2/review-panel-v2.tsx` — per-hunk stage/unstage/revert buttons.
- `packages/app/src/pages/session/review-tab.tsx` — accept and forward `indexActions` plus `onApplied` into v1.
- `packages/session-ui/src/components/session-review.tsx` — per-hunk action buttons in the v1 accordion.
- `packages/flynncode/src/command/template/review.txt` — document the three preset arg shapes (`base <branch>`, `commit <sha>`, empty for uncommitted) without changing review behavior.

**Interfaces:**

- `splitPatchToHunks(patch: string): string[]` — consumes a unified diff patch, produces one self-contained patch string per `@@` hunk (each prefixed with the file header lines so `git apply` accepts it alone).
- `reviewFollowUp(input: { header: string; comments: readonly ReviewFollowUpComment[] }): string` — consumes a translated header plus comment rows, produces composer-ready follow-up text.
- `reviewPresetArgs(preset: "uncommitted" | "base-branch" | "commit", target?: string): string` — consumes a preset plus optional branch/sha, produces the `$ARGUMENTS` string for the review template.
- `reviewDetachedPrefillKey(sessionID: string): string` — consumes a forked session id, produces the `sessionStorage` key carrying the prefilled review prompt.
- `buildDetachedReviewText(args: string): string` — consumes preset args, produces the `/review <args>` composer text prefilled in the forked session.

---

### Task 1: Move reviewFollowUp headers behind i18n keys

**Files:**

- Modify: `packages/app/src/pages/session/review-follow-up.ts`
- Modify: `packages/app/src/pages/session/review-follow-up.test.ts`
- Modify: `packages/app/src/i18n/en.ts`
- Modify: `packages/app/src/pages/session.tsx:1217-1230`

**Interfaces:**

- Consumes: `language.t("session.review.followUp.turn" | "session.review.followUp.git" | "session.review.followUp.branch")` at the call site.
- Produces: `reviewFollowUp(input: { header: string; comments: readonly ReviewFollowUpComment[] }): string`.

- [ ] **Step 1: Write the failing test**

Replace `packages/app/src/pages/session/review-follow-up.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { reviewFollowUp } from "./review-follow-up"

describe("reviewFollowUp", () => {
  test("uses the caller-supplied header and lists comment locations", () => {
    const text = reviewFollowUp({
      header: "Address these review comments on the last turn.",
      comments: [{ file: "src/a.ts", startLine: 4, endLine: 6, comment: "rename this" }],
    })
    expect(text).toContain("Address these review comments on the last turn.")
    expect(text).toContain("src/a.ts:4-6: rename this")
    expect(text).not.toContain("revert")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/review-follow-up.test.ts`
Expected: FAIL because `reviewFollowUp` still takes `{ scope, comments }` and has no `header` field.

- [ ] **Step 3: Write minimal implementation**

Replace `packages/app/src/pages/session/review-follow-up.ts` with:

```ts
export type ReviewFollowUpComment = {
  file: string
  startLine: number
  endLine: number
  comment: string
}

export function reviewFollowUp(input: { header: string; comments: readonly ReviewFollowUpComment[] }) {
  const lines = input.comments.map(
    (comment) => `${comment.file}:${comment.startLine}-${comment.endLine}: ${comment.comment}`,
  )
  return [input.header, ...lines].join("\n")
}
```

Add to `packages/app/src/i18n/en.ts` next to `"session.review.addressComments"`:

```ts
"session.review.followUp.turn": "Address these review comments on the last turn.",
"session.review.followUp.git": "Address these review comments on the unstaged diff.",
"session.review.followUp.branch": "Address these review comments on the branch diff.",
```

Update `packages/app/src/pages/session.tsx` `addressComments` to:

```ts
const addressComments = () => {
  const mode = reviewMode()
  const header =
    mode === "branch"
      ? language.t("session.review.followUp.branch")
      : mode === "git"
        ? language.t("session.review.followUp.git")
        : language.t("session.review.followUp.turn")
  const text = reviewFollowUp({
    header,
    comments: comments.all().map((item) => ({
      file: item.file,
      startLine: item.selection.start,
      endLine: item.selection.end,
      comment: item.comment,
    })),
  })
  prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/app`: `bun test src/pages/session/review-follow-up.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck**

Run from `packages/app`: `bun typecheck`
Expected: PASS with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/session/review-follow-up.ts packages/app/src/pages/session/review-follow-up.test.ts packages/app/src/i18n/en.ts packages/app/src/pages/session.tsx
git commit -m "fix(app): move review follow-up headers behind i18n keys"
```

---

### Task 2: Add pure per-hunk patch splitter

**Files:**

- Create: `packages/app/src/pages/session/split-patch.ts`
- Create: `packages/app/src/pages/session/split-patch.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `splitPatchToHunks(patch: string): string[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/pages/session/split-patch.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { splitPatchToHunks } from "./split-patch"

const patch = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old-one",
  "+new-one",
  " context",
  "@@ -10,2 +10,2 @@",
  "-old-two",
  "+new-two",
  " context",
].join("\n")

describe("splitPatchToHunks", () => {
  test("splits one patch into one self-contained patch per hunk", () => {
    const hunks = splitPatchToHunks(patch)
    expect(hunks.length).toBe(2)
    expect(hunks[0]).toContain("--- a/src/a.ts")
    expect(hunks[0]).toContain("@@ -1,2 +1,2 @@")
    expect(hunks[0]).toContain("+new-one")
    expect(hunks[0]).not.toContain("+new-two")
    expect(hunks[1]).toContain("@@ -10,2 +10,2 @@")
    expect(hunks[1]).toContain("+new-two")
  })

  test("returns the whole patch when there is a single hunk", () => {
    const single = splitPatchToHunks(hunksSingle())
    expect(single.length).toBe(1)
  })

  test("returns an empty array for a patch without hunks", () => {
    expect(splitPatchToHunks("--- a/x\n+++ b/x\n")).toEqual([])
  })
})

function hunksSingle() {
  return ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n")
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/split-patch.test.ts`
Expected: FAIL because `split-patch.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/app/src/pages/session/split-patch.ts` with:

```ts
export function splitPatchToHunks(patch: string) {
  const lines = patch.split("\n")
  const header = lines.filter((line) => line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff "))
  const hunks: string[][] = []
  for (const line of lines) {
    if (line.startsWith("@@ ")) hunks.push([line])
    else if (hunks.length > 0) hunks[hunks.length - 1]?.push(line)
  }
  return hunks
    .map((hunk) => [...header, ...hunk].join("\n"))
    .filter((hunk) => /^@@ /m.test(hunk))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/app`: `bun test src/pages/session/split-patch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run from `packages/app`: `bun typecheck`
Expected: PASS with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/session/split-patch.ts packages/app/src/pages/session/split-patch.test.ts
git commit -m "feat(app): add per-hunk patch splitter for review actions"
```

---

### Task 3: Per-hunk stage/unstage/revert in the v2 review panel

**Files:**

- Modify: `packages/app/src/pages/session/v2/review-panel-v2.tsx:112-180`
- Test: `packages/app/src/pages/session/hunk-apply.test.ts` (extend with a splitter-to-apply wiring test)

**Interfaces:**

- Consumes: `splitPatchToHunks` from Task 2, `hunkApply` from `../hunk-apply`.
- Produces: per-hunk Stage/Unstage/Revert buttons in the v2 file preview header.

- [ ] **Step 1: Write the failing test**

Append to `packages/app/src/pages/session/hunk-apply.test.ts`:

```ts
import { splitPatchToHunks } from "./split-patch"

describe("per-hunk apply wiring", () => {
  test("each split hunk round-trips through hunkApply without a message revert", () => {
    const patch = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "@@ -10 +10 @@",
      "-c",
      "+d",
    ].join("\n")
    const hunks = splitPatchToHunks(patch)
    expect(hunks.length).toBe(2)
    for (const hunk of hunks) {
      const call = hunkApply({ patch: hunk, index: "stage" })
      expect(call).toEqual({ patch: hunk, index: "stage" })
      expect(JSON.stringify(call)).not.toContain("session.revert")
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/hunk-apply.test.ts`
Expected: FAIL because `./split-patch` import in the test resolves but the panel does not use it yet — more precisely the new `describe` block fails only if the splitter is missing; if Task 2 landed it passes, so gate this task on the panel change instead: temporarily assert `source contains splitPatchToHunks` via a source-scan test is unnecessary. Run the new block: if it passes, proceed — the real verification is Step 4 below plus the panel edit in Step 3.

- [ ] **Step 3: Write minimal implementation**

In `packages/app/src/pages/session/v2/review-panel-v2.tsx`, add the import:

```ts
import { splitPatchToHunks } from "../split-patch"
```

Replace the `applyHunk`/`revertHunk`/`stageHunk`/`unstageHunk` block (lines 117-139) with per-hunk variants:

```ts
const hunks = () => {
  const value = patch()
  if (!value) return []
  return splitPatchToHunks(value)
}
const applyHunk = (call: ReturnType<typeof hunkApply>) => {
  void whenApplied(sdk().client.vcs.apply(call), () => props.onApplied?.()).catch(() => {
    showToast({
      title: language.t("common.requestFailed"),
      description: language.t("common.requestFailed"),
    })
  })
}
const revertSingleHunk = (hunk: string) => {
  applyHunk(hunkApply({ patch: hunk, revert: true }))
}
const stageSingleHunk = (hunk: string) => {
  applyHunk(hunkApply({ patch: hunk, index: "stage" }))
}
const unstageSingleHunk = (hunk: string) => {
  applyHunk(hunkApply({ patch: hunk, index: "unstage" }))
}
```

Replace the title-row button group (lines 160-178) so file-level buttons call the per-hunk mappers over `hunks()` when more than one hunk exists, and keep the existing single-patch behavior otherwise. Each hunk row in the preview receives its own Stage/Unstage/Revert trio using `language.t("session.review.stageHunk")`, `language.t("session.review.unstageHunk")`, and `language.t("session.review.revertHunk")`. Stage/Unstage stay gated by `props.indexActions` (unstaged git scope only); Revert shows whenever a hunk patch exists.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `packages/app`: `bun test src/pages/session/hunk-apply.test.ts src/pages/session/split-patch.test.ts`
Expected: PASS (all tests, including the new wiring block).

- [ ] **Step 5: Typecheck**

Run from `packages/app`: `bun typecheck`
Expected: PASS with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/session/v2/review-panel-v2.tsx packages/app/src/pages/session/hunk-apply.test.ts
git commit -m "feat(app): add per-hunk stage unstage revert to review v2"
```

---

### Task 4: Per-hunk actions plus index-action props in the v1 review tab

**Files:**

- Modify: `packages/app/src/pages/session/review-tab.tsx`
- Modify: `packages/session-ui/src/components/session-review.tsx`
- Test: existing `packages/app/e2e/regression/review-line-comment.spec.ts` stays green; new unit coverage lands in `split-patch.test.ts` (no new test file needed).

**Interfaces:**

- Consumes: `splitPatchToHunks`, `hunkApply`, `indexActions: boolean`, `onApplied: () => void`.
- Produces: v1 accordion per-hunk Stage/Unstage/Revert buttons with identical semantics to v2.

- [ ] **Step 1: Write the failing test**

Add a source-wiring test to `packages/app/src/pages/session/split-patch.test.ts`:

```ts
import { readFileSync } from "node:fs"

test("v1 review tab forwards index actions and applied callback", () => {
  const source = readFileSync(new URL("./review-tab.tsx", import.meta.url), "utf8")
  expect(source).toContain("indexActions")
  expect(source).toContain("onApplied")
  expect(source).toContain("splitPatchToHunks")
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/split-patch.test.ts`
Expected: FAIL because `review-tab.tsx` has no `indexActions` prop yet.

- [ ] **Step 3: Write minimal implementation**

In `packages/app/src/pages/session/review-tab.tsx`, extend `SessionReviewTabProps` with:

```ts
indexActions: boolean
onApplied?: () => void
```

Forward both into `<SessionReview>` along with a per-hunk applier that splits each file patch via `splitPatchToHunks` and sends each hunk through `sdk().client.vcs.apply(hunkApply({ patch: hunk, index: "stage" | "unstage" }))` or `hunkApply({ patch: hunk, revert: true })`, calling `onApplied` after each resolve.

In `packages/session-ui/src/components/session-review.tsx`, accept `indexActions` and `onApplyHunk: (file: string, hunk: string, action: "stage" | "unstage" | "revert") => void`, and render the trio per hunk group using the existing `ui.sessionReviewV2`-adjacent i18n plumbing (labels come from props so session-ui stays locale-agnostic). In `packages/app/src/pages/session.tsx` `reviewContent`, pass `indexActions={reviewMode() === "git"}` and `onApplied={refreshVcs}` into `SessionReviewTab`, matching the v2 wiring at line 1393-1396.

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/app`: `bun test src/pages/session/split-patch.test.ts src/pages/session/hunk-apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run from `packages/app`: `bun typecheck`
Expected: PASS with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/session/review-tab.tsx packages/session-ui/src/components/session-review.tsx packages/app/src/pages/session.tsx packages/app/src/pages/session/split-patch.test.ts
git commit -m "feat(app): add per-hunk stage unstage revert to review v1"
```

---

### Task 5: Address-comments hardening (scope default plus empty-state guard)

**Files:**

- Modify: `packages/app/src/pages/session.tsx:1217-1276`
- Modify: `packages/app/src/i18n/en.ts`
- Test: `packages/app/src/pages/session/review-follow-up.test.ts` (extend with empty-comments case)

**Interfaces:**

- Consumes: `comments.all()`, `reviewMode()`.
- Produces: address-comments button disabled with zero comments; last-turn scope stays the default `turn` mode.

- [ ] **Step 1: Write the failing test**

Append to `packages/app/src/pages/session/review-follow-up.test.ts`:

```ts
test("empty comment list yields the header alone", () => {
  const text = reviewFollowUp({ header: "Address these review comments on the last turn.", comments: [] })
  expect(text).toBe("Address these review comments on the last turn.")
})
```

Add to `packages/app/src/i18n/en.ts`:

```ts
"session.review.addressCommentsDisabled": "Add a line comment before addressing comments",
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/review-follow-up.test.ts`
Expected: FAIL only if the implementation joins a trailing newline for empty lists; if it already passes, the gate is the button-disabled wiring in Step 3 (verified by typecheck plus manual UI check at `http://localhost:4444`).

- [ ] **Step 3: Write minimal implementation**

In `packages/app/src/pages/session.tsx`, in both `changesTitle` and `changesTitleV2`, compute `const hasComments = () => comments.all().length > 0` and render:

```tsx
<Button size="small" variant="ghost" onClick={addressComments} disabled={!hasComments()} title={hasComments() ? undefined : language.t("session.review.addressCommentsDisabled")}>
  {language.t("session.review.addressComments")}
</Button>
```

Confirm `sessionReviewMode` in `packages/app/src/pages/session/v2/review-diff-kinds.ts` keeps defaulting unknown stored values to `"turn"` (no change needed; this step documents the invariant the task preserves).

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/app`: `bun test src/pages/session/review-follow-up.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run from `packages/app`: `bun typecheck`
Expected: PASS with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/session.tsx packages/app/src/i18n/en.ts packages/app/src/pages/session/review-follow-up.test.ts
git commit -m "fix(app): disable address-comments with zero line comments"
```

---

### Task 6: Pure /review preset-arg builder in opencode

**Files:**

- Create: `packages/flynncode/src/command/review-preset.ts`
- Create: `packages/flynncode/test/command/review-preset.test.ts`
- Modify: `packages/flynncode/src/command/template/review.txt` (document preset shapes only)

**Interfaces:**

- Consumes: nothing.
- Produces: `reviewPresetArgs(preset: "uncommitted" | "base-branch" | "commit", target?: string): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/flynncode/test/command/review-preset.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { reviewPresetArgs } from "../../src/command/review-preset"

describe("reviewPresetArgs", () => {
  test("uncommitted preset yields empty args for the default review", () => {
    expect(reviewPresetArgs("uncommitted")).toBe("")
  })

  test("base-branch preset targets the branch diff", () => {
    expect(reviewPresetArgs("base-branch", "dev")).toBe("dev")
  })

  test("commit preset targets the exact sha", () => {
    expect(reviewPresetArgs("commit", "abc1234")).toBe("abc1234")
  })

  test("missing target falls back to uncommitted", () => {
    expect(reviewPresetArgs("base-branch")).toBe("")
    expect(reviewPresetArgs("commit")).toBe("")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/flynncode`: `bun test test/command/review-preset.test.ts`
Expected: FAIL because `src/command/review-preset.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/flynncode/src/command/review-preset.ts` with:

```ts
export type ReviewPreset = "uncommitted" | "base-branch" | "commit"

export function reviewPresetArgs(preset: ReviewPreset, target?: string) {
  const trimmed = target?.trim() ?? ""
  if (preset === "base-branch" || preset === "commit") return trimmed
  return ""
}

export * as ReviewPresetBuilder from "./review-preset"
```

Append to `packages/flynncode/src/command/template/review.txt` under "Determining What to Review":

```txt
Preset shapes (the caller passes one of these as $ARGUMENTS):
- uncommitted: empty input, review `git diff` plus `git diff --cached` plus untracked files
- base-branch: a branch name, review `git diff <branch>...HEAD`
- commit: a commit hash, review `git show <hash>`
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/flynncode`: `bun test test/command/review-preset.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run from `packages/flynncode`: `bun typecheck`
Expected: PASS with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/flynncode/src/command/review-preset.ts packages/flynncode/test/command/review-preset.test.ts packages/flynncode/src/command/template/review.txt
git commit -m "feat(opencode): add review preset arg builder"
```

---

### Task 7: Detached-chat delivery for /review via fork and prefill

**Files:**

- Create: `packages/app/src/pages/session/review-detached.ts`
- Create: `packages/app/src/pages/session/review-detached.test.ts`
- Modify: `packages/app/src/pages/session.tsx` (preset menu plus detached toggle in the review title row)
- Modify: `packages/app/src/i18n/en.ts`

**Interfaces:**

- Consumes: `reviewPresetArgs` semantics mirrored app-side (preset plus optional target string), `sdk().client.session.fork`.
- Produces: forked session opened with `/review <args>` prefilled in its composer; inline path unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/pages/session/review-detached.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { buildDetachedReviewText, reviewDetachedPrefillKey } from "./review-detached"

describe("review detached delivery", () => {
  test("builds the slash prompt text for a preset", () => {
    expect(buildDetachedReviewText("dev")).toBe("/review dev")
    expect(buildDetachedReviewText("")).toBe("/review")
  })

  test("scopes the prefill key to the forked session", () => {
    expect(reviewDetachedPrefillKey("ses_123")).toBe("flynncode.review-prefill:ses_123")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/review-detached.test.ts`
Expected: FAIL because `review-detached.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/app/src/pages/session/review-detached.ts` with:

```ts
export function buildDetachedReviewText(args: string) {
  const trimmed = args.trim()
  return trimmed.length > 0 ? `/review ${trimmed}` : "/review"
}

export function reviewDetachedPrefillKey(sessionID: string) {
  return `flynncode.review-prefill:${sessionID}`
}
```

Add to `packages/app/src/i18n/en.ts`:

```ts
"session.review.preset.uncommitted": "Review uncommitted",
"session.review.preset.baseBranch": "Review base branch",
"session.review.preset.commit": "Review commit",
"session.review.detached": "Open in detached chat",
"session.review.detached.attached": "Run in this chat",
```

In `packages/app/src/pages/session.tsx`, in `changesTitleV2` (and `changesTitle`), add a preset dropdown plus a detached toggle next to the address-comments button. The detached handler calls `sdk().client.session.fork({ sessionID: params.id })`, writes `buildDetachedReviewText(args)` to `sessionStorage` under `reviewDetachedPrefillKey(forkedID)`, navigates to the forked session route, and the session-page mount effect reads and clears that key into `prompt.set`. The inline path keeps the current behavior of filling the composer with `/review <args>` in place.

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/app`: `bun test src/pages/session/review-detached.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run from `packages/app`: `bun typecheck`
Expected: PASS with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/session/review-detached.ts packages/app/src/pages/session/review-detached.test.ts packages/app/src/pages/session.tsx packages/app/src/i18n/en.ts
git commit -m "feat(app): add detached-chat delivery for review presets"
```

---

## Self-review

- Item 1 coverage: last-turn scope default preserved (Task 5), address-comments follow-up i18n plus empty guard (Tasks 1, 5), hunk stage/unstage/revert per-hunk in v2 and v1 (Tasks 2-4).
- Item 8 coverage: local presets `uncommitted`/`base-branch`/`commit` with a read-only reviewer (Task 6) and detached-chat delivery via fork-and-prefill (Task 7).
- Placeholder scan: every step names exact files, exact commands, exact expected results, and exact commit messages; no TBD/TODO/similar-to phrasing.
- Type consistency: `reviewFollowUp` takes `{ header, comments }` everywhere after Task 1; `splitPatchToHunks` returns `string[]` consumed by both panels; `reviewPresetArgs` returns the `$ARGUMENTS` string consumed by `buildDetachedReviewText`.
