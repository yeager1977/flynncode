# Hunk Stage and Unstage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage and unstage the active unstaged hunk through the existing `vcs.apply` endpoint, without a second VCS route and without calling message revert.

**Architecture:** A pure `applyArgs` function maps `worktree`, `stage`, and `unstage` onto `git apply` flags. `Vcs.apply` passes the optional `index` field through `Git.applyPatch`. The review pane shows stage and unstage only for the unstaged git scope and sends the file patch to the existing client method.

**Tech Stack:** Effect v4, existing `Git` service, Server HttpApi, generated JS SDK, SolidJS review panel.

## Global Constraints

- Product is Flynncode, not upstream OpenCode.
- Do not add a `/vcs/hunk` route.
- Omitted `index` means working-tree `git apply -`.
- Stage and unstage appear only when the selected scope is the unstaged git diff and the active file has a patch.
- Revert stays `reversePatch(patch)` with `index` omitted. It must not call the session revert API.
- Non-git stays `PatchApplyError` reason `non-git`. A patch that does not apply stays reason `not-clean`. Neither changes the checkout.
- Button labels use i18n keys. Do not invent translations. English source may be the fallback.
- After the public HttpApi change, regenerate clients. Do not edit generated files by hand.
- Do not restart an existing app or server on ports 4096 or 4444.
- Run tests from package directories, never the repo root.
- Do not commit unless the user asks.

---

### Task 1: Apply argument mapping

**Files:**
- Create: `packages/opencode/src/git/apply-args.ts`
- Test: `packages/opencode/test/git/apply-args.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ApplyIndex` and `applyArgs(index?: ApplyIndex): string[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { applyArgs } from "../../src/git/apply-args"

describe("applyArgs", () => {
  test("maps omitted and worktree to plain apply", () => {
    expect(applyArgs()).toEqual(["apply", "-"])
    expect(applyArgs("worktree")).toEqual(["apply", "-"])
  })

  test("maps stage and unstage to cached apply", () => {
    expect(applyArgs("stage")).toEqual(["apply", "--cached", "-"])
    expect(applyArgs("unstage")).toEqual(["apply", "--cached", "-R", "-"])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/opencode`: `bun test test/git/apply-args.test.ts`
Expected: FAIL because `apply-args` is missing.

- [ ] **Step 3: Write the mapping**

```ts
export type ApplyIndex = "worktree" | "stage" | "unstage"

export function applyArgs(index: ApplyIndex = "worktree") {
  if (index === "stage") return ["apply", "--cached", "-"]
  if (index === "unstage") return ["apply", "--cached", "-R", "-"]
  return ["apply", "-"]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/opencode`: `bun test test/git/apply-args.test.ts`
Expected: PASS

### Task 2: Wire Git and Vcs

**Files:**
- Modify: `packages/opencode/src/git/index.ts`
- Modify: `packages/opencode/src/project/vcs.ts`
- Test: `packages/opencode/test/git/git.test.ts`

**Interfaces:**
- Consumes: `applyArgs`, `ApplyIndex`
- Produces: `Git.applyPatch(cwd, patch, index?)` and `Vcs.ApplyInput.index`

- [ ] **Step 1: Extend the Git method**

In `packages/opencode/src/git/index.ts`, import `{ applyArgs, type ApplyIndex } from "./apply-args"`.

Change the interface and implementation to:

```ts
readonly applyPatch: (cwd: string, patch: string, index?: ApplyIndex) => Effect.Effect<Result>
```

```ts
const applyPatch = Effect.fn("Git.applyPatch")(function* (cwd: string, patch: string, index?: ApplyIndex) {
  return yield* run(applyArgs(index), { cwd, stdin: stdin(patch) })
})
```

- [ ] **Step 2: Extend ApplyInput**

In `packages/opencode/src/project/vcs.ts`, import `ApplyIndex` from `@/git/apply-args` only if that alias resolves. If `@/git` is the existing import style, add the type import next to `import { Git } from "@/git"`.

```ts
export const ApplyInput = Schema.Struct({
  patch: Schema.String,
  index: Schema.optional(Schema.Literals(["worktree", "stage", "unstage"])),
})
```

Pass the field through:

```ts
const applied = yield* git.applyPatch(ctx.directory, input.patch, input.index)
```

Do not change the `non-git` or `not-clean` error reasons.

- [ ] **Step 3: Add a live git test**

Append to `packages/opencode/test/git/git.test.ts` inside `describe("Git")`:

```ts
it.live("stage moves a worktree hunk to the index and unstage moves it back", () =>
  Effect.gen(function* () {
    const tmp = yield* scopedTmpdir({ git: true })
    const file = path.join(tmp.path, "note.txt")
    yield* Effect.promise(() => fs.writeFile(file, "next\n"))
    const git = yield* Git.Service
    const patch = yield* git.patch(tmp.path, "HEAD", "note.txt")
    const staged = yield* git.applyPatch(tmp.path, patch.text, "stage")
    expect(staged.exitCode).toBe(0)
    const cached = yield* git.run(["diff", "--cached", "--name-only"], { cwd: tmp.path })
    expect(cached.text()).toContain("note.txt")
    const unstaged = yield* git.applyPatch(tmp.path, patch.text, "unstage")
    expect(unstaged.exitCode).toBe(0)
    const cleared = yield* git.run(["diff", "--cached", "--name-only"], { cwd: tmp.path })
    expect(cleared.text().trim()).toBe("")
  }),
)
```

Confirm `git.patch` returns `{ text: string }` by reading `Patch` in `packages/opencode/src/git/index.ts` before writing the test. If the field name differs, use the real field. Do not invent a second patch reader.

- [ ] **Step 4: Run the git tests**

Run from `packages/opencode`: `bun test test/git/apply-args.test.ts test/git/git.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck the server package**

Run from `packages/opencode`: `bun typecheck`
Expected: exit 0

### Task 3: Regenerate clients

**Files:**
- Modify: generated client output only, via the generate scripts
- Do not hand-edit `packages/sdk/js/src/v2/gen` or `packages/client/src/generated`

**Interfaces:**
- Consumes: `Vcs.ApplyInput.index`
- Produces: `client.vcs.apply({ patch, index })` in the JS SDK used by `packages/app`

- [ ] **Step 1: Regenerate the public client**

Run from `packages/client`: `bun run generate`
Expected: generated files include optional `index` on the VCS apply payload.

- [ ] **Step 2: Regenerate the legacy JS SDK**

Run from the repo root: `./packages/sdk/js/script/build.ts`
Expected: `packages/sdk/js/src/v2/gen/sdk.gen.ts` `vcs.apply` accepts `index?: "worktree" | "stage" | "unstage"`.

If generate tries to bind port 4096 and a server is already there, stop and use the documented generate path that does not restart that server. Do not kill the existing process.

### Task 4: Review controls

**Files:**
- Create: `packages/app/src/pages/session/hunk-apply.ts`
- Test: `packages/app/src/pages/session/hunk-apply.test.ts`
- Modify: `packages/app/src/pages/session/v2/review-panel-v2.tsx`
- Modify: `packages/app/src/pages/session.tsx`
- Modify: `packages/app/src/i18n/en.ts`

**Interfaces:**
- Consumes: `reversePatch`, `client.vcs.apply`, `reviewMode()`
- Produces: `reviewIndexActions(scope)` and `hunkApply(input)`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { hunkApply, reviewIndexActions } from "./hunk-apply"

describe("reviewIndexActions", () => {
  test("shows stage and unstage only for the unstaged git scope", () => {
    expect(reviewIndexActions("git")).toBe(true)
    expect(reviewIndexActions("branch")).toBe(false)
    expect(reviewIndexActions("turn")).toBe(false)
  })
})

describe("hunkApply", () => {
  test("revert reverses the patch and does not name a message revert", () => {
    const call = hunkApply({ patch: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n", revert: true })
    expect(call.patch).toContain("-new")
    expect(call.index).toBeUndefined()
    expect(JSON.stringify(call)).not.toContain("session.revert")
  })

  test("stage and unstage send the original patch and the index mode", () => {
    expect(hunkApply({ patch: "diff", index: "stage" })).toEqual({ patch: "diff", index: "stage" })
    expect(hunkApply({ patch: "diff", index: "unstage" })).toEqual({ patch: "diff", index: "unstage" })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/app`: `bun test src/pages/session/hunk-apply.test.ts`
Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the helper**

```ts
import { reversePatch } from "./hunk-revert"

export type HunkIndex = "worktree" | "stage" | "unstage"
export type ReviewScope = "git" | "branch" | "turn"

export function reviewIndexActions(scope: ReviewScope) {
  return scope === "git"
}

export function hunkApply(input: { patch: string; index?: HunkIndex; revert?: boolean }) {
  if (input.revert) return { patch: reversePatch(input.patch) }
  return { patch: input.patch, index: input.index }
}
```

- [ ] **Step 4: Add English keys**

In `packages/app/src/i18n/en.ts`, next to `session.review.revertHunk`:

```ts
"session.review.stageHunk": "Stage hunk",
"session.review.unstageHunk": "Unstage hunk",
```

Do not copy invented translations into other locale files. They are `Partial` and fall back to English.

- [ ] **Step 5: Pass the scope into the review panel**

Add `indexActions: boolean` to `ReviewPanelV2Props`. In `reviewPanelV2Props()` in `packages/app/src/pages/session.tsx`, set `indexActions: reviewMode() === "git"`.

In `review-panel-v2.tsx`:

- Import `showToast` from `@/utils/toast` and `hunkApply` from `../hunk-apply`.
- Replace the direct `vcs.apply({ patch: reversePatch(value) })` call with a helper that sends `hunkApply(...)`, catches failure, and calls `showToast({ title: language.t("common.requestFailed"), description: language.t("common.requestFailed") })`.
- Render stage and unstage buttons only when `props.indexActions && patch()`.
- Stage sends `hunkApply({ patch: value, index: "stage" })`.
- Unstage sends `hunkApply({ patch: value, index: "unstage" })`.
- Revert sends `hunkApply({ patch: value, revert: true })`.
- Do not import or call `session.revert`.

- [ ] **Step 6: Run app tests and typecheck**

Run from `packages/app`: `bun test src/pages/session/hunk-apply.test.ts src/pages/session/hunk-revert.test.ts`
Expected: PASS

Run from `packages/app`: `bun typecheck`
Expected: exit 0

## Self-review

- Spec mode mapping is Task 1 and Task 2.
- Index buttons hidden off the unstaged scope are Task 4.
- Failed apply does not call message revert: the helper has no revert session field, and the panel must not import that API.
- No second VCS route is added.
- Artifact preview and project memory are not in this plan.

## Execution note

Commit only if the user asks. Suggested messages if they do:

- `feat(opencode): stage hunks through vcs apply`
- `feat(app): show stage and unstage on unstaged review`
