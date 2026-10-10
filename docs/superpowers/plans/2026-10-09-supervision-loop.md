# Supervision Loop (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the research report's Phase-1 supervision-loop gaps: subagent stop/steer directory routing, a dedicated `/review` agent + preset wiring, one-click "address comments", worktree retention correctness + Local↔Worktree handoff, routine liveliness in the activity inbox, and permission hardening (hook trigger, dock wiring, auto reviewer, settings page).

**Architecture:** This is a gap-closing plan, not greenfield — prior work on `dev` already ships the review pane (`turn` mode + hunk actions), subagent stop/steer UI, disposable worktrees + handoff, and the activity inbox dialog. Each task targets one verified gap found by line-level research of the current tree (`codex-parity-build`).

**Tech Stack:** Effect-TS v4 (effect-smol), SolidJS (packages/app), Bun test, Drizzle/SQLite, HttpApi (protocol/server/client with codegen), i18n dictionaries with fallback modules.

## Global Constraints

- Branch: `codex-parity-build`. Never commit directly to `dev`; single final no-ff merge happens after all four phases (not in this plan).
- Tests run from package dirs only (guard: `do-not-run-tests-from-root`), e.g. `bun test <path>` from `packages/opencode`, `bun test --isolate --conditions=solid --only-failures --preload ./happydom.ts <path>` from `packages/app`.
- Typecheck via `bun typecheck` from package directories, never `tsc` directly.
- i18n: English source in `packages/app/src/i18n/en.ts`; new Flynncode-only keys registered in `packages/app/src/i18n/flynncode-fallback.ts` keys array; never hardcode English in components; never mutate existing English strings.
- Reuse existing route/tool/service names exactly; do not invent APIs. HttpApi shape changes require `bun run generate` from `packages/client` (never edit `src/generated`/`src/generated-effect`).
- Effect style: bind services to named variables before calling methods (no `yield* (yield* Foo.Service).bar()`); sync logic stays out of Effect; prefer `const`/early returns/no `else`; no `any`.
- Conventional commits: `fix(app): …`, `feat(core): …`, `test(plugin): …` etc.
- Sandbox enforcement is path-based and ask-time today; this plan does NOT add OS-level sandboxing (tracked as spec risk; separate effort).

---

### Task 1: Subagent stop/steer must route to the child's instance directory [item 9]

**Files:**
- Modify: `packages/app/src/pages/session/subagent-list-view.tsx` (Row's `stopChild` ~L176–186, `submitSteer` ~L188–205, row building ~L26–44)
- Test: `packages/app/src/pages/session/subagent-list-source.test.ts` (extend existing `describe("subagent list stop + steer wiring")`)

**Interfaces:**
- Consumes: existing SDK client methods `sdk().client.session.abort({ sessionID, directory? })` (v2 gen, `sdk.gen.ts` ~L4478 — accepts `directory`) and `sdk().client.session.prompt({ sessionID, parts, delivery, directory? })` (legacy surface accepts a `directory` query resolved by `InstanceContextMiddleware`).
- Produces: child rows carry `directory`; abort/steer calls include it. No API changes.

- [ ] **Step 1: Write the failing assertion**

Extend the existing source-contract test file (`packages/app/src/pages/session/subagent-list-source.test.ts`, inside the existing `describe` block):

```ts
test("abort and steer route to the child's instance directory", () => {
  const source = readFileSync(new URL("./subagent-list-view.tsx", import.meta.url), "utf8")
  expect(source).toContain('session.abort({ sessionID: props.child.id, directory: props.child.directory')
  expect(source).toContain('delivery: "steer", directory: props.child.directory')
})
```

(If the exact call-shaped strings differ after implementation, assert instead that both calls reference `props.child.directory` — the invariant is that the child's `directory` is passed on both.)

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/session/subagent-list-source.test.ts`
Expected: FAIL (calls currently pass only `sessionID`).

- [ ] **Step 3: Implement**

In `subagent-list-view.tsx` `Row`, thread the child session's `directory` (available on `SessionSchema.Info`, already in `sync().data.session[childID]`) into the two call sites:

```ts
const stopChild = async () => {
  // Run state lives in the target's instance: a worktree-isolated subagent
  // runs under its worktree directory (same pattern as tool/message.ts:57-60).
  await sdk().client.session.abort({ sessionID: props.child.id, directory: props.child.directory })
}

const submitSteer = async (event: SubmitEvent) => {
  // ...existing text extraction...
  await sdk().client.session.prompt({
    sessionID: props.child.id,
    parts: [{ type: "text", text }],
    delivery: "steer",
    directory: props.child.directory,
  })
}
```

Ensure the row's child object maps `directory` from the session entry (add it in the `createMemo` row builder if missing). Note: subagents that are `directory`-less (implicit local) pass `undefined`, which is the current behavior — no regression.

- [ ] **Step 4: Run tests to verify they pass**

Run from `packages/app`: same command as Step 2 for the source test, plus `bun test src/pages/session/subagent-list.test.ts`.
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run from `packages/app`: `bun typecheck || bunx biome check src/pages/session` (use the package's typecheck script). Then:

```bash
git add packages/app/src/pages/session/subagent-list-view.tsx packages/app/src/pages/session/subagent-list-source.test.ts
git commit -m "fix(app): route subagent stop and steer through the child's directory"
```

---

### Task 2: Dedicated read-only `review` agent pinned by `/review` [item 8]

**Files:**
- Create: `packages/opencode/src/agent/prompt/review.txt`
- Modify: `packages/opencode/src/agent/agent.ts` (built-in `agents` record, after `explore` at ~L242–264)
- Modify: `packages/opencode/src/command/index.ts` (~L85, `agent: "explore"` → `agent: "review"`)
- Test: `packages/opencode/test/command/review-command.test.ts` (new)

**Interfaces:**
- Consumes: built-in agent registration pattern (`plan`/`explore` entries, `agent.ts` L162–264; `Permission.merge` + `Permission.fromConfig`; hidden hidden-agent pattern); command registry `commands[Default.REVIEW]`.
- Produces: agent id `"review"` (subagent-mode, hard read-only). Task 3's test may pin it.

- [ ] **Step 1: Write the failing test**

`packages/opencode/test/command/review-command.test.ts` — mirror the instance-test style of `test/server/session-actions.test.ts` (`it.instance` + `TestInstance` + `requestInDirectory` + `httpApiLayer`); write the full arrangement with the same imports that file already uses. Assertions are the contract (harness plumbing mirrors existing instance tests):

```ts
it.instance("review command pins a dedicated read-only review agent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    // Fetch the built-in command registry and agent definitions the same way
    // session-actions.test.ts reaches services (yield* TestInstance, then the
    // command/agent service from the instance layer — reuse its accessors).
    const review = yield* commandService.get("review")
    expect(review.agent).toBe("review")

    const agent = yield* agentService.get("review")
    expect(agent.mode).toBe("subagent")
    expect(Permission.evaluate(agent.permission, "edit", "src/anything.ts").action).toBe("deny")
    expect(Permission.evaluate(agent.permission, "read", "src/anything.ts").action).toBe("allow")
    expect(Permission.evaluate(agent.permission, "bash", "git status").action).toBe("allow")
  }))
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/opencode`: `bun test ./test/command/review-command.test.ts`
Expected: FAIL (`review` agent does not exist; command pins `explore`).

- [ ] **Step 3: Create the review prompt**

`packages/opencode/src/agent/prompt/review.txt` — a focused reviewer prompt (modeled on `explore.txt`'s tone, no tool-ceremony, never mutates; instructs: read-only review, report findings as severity-tagged list, explicitly do not run tests, do not apply edits):

```
You are a code review agent. You review changes and NEVER modify files.
Review mode and target come from the user prompt.
Classify findings as P0 (merge-blocking) / P1 (should fix) / P2 (nit).
Report per finding: file:line, severity, one-sentence reason, suggested fix.
Do not run tests. Do not use commands that mutate the repo (no commit, checkout,
apply, stash, push). Read-only commands (git diff, git show, git log, read, grep, glob) are fine.
End with a one-paragraph verdict: approve or request changes.
```

- [ ] **Step 4: Register the agent + switch the command**

In `packages/opencode/src/agent/agent.ts`, add to the built-in `agents` record after `explore` (following the `explore` shape at L242–264):

```ts
review: {
  id: "review",
  mode: "subagent",
  native: true,
  // Review stays read-only like explore, but without web tools — diffs only.
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "allow",
      external_directory: readonlyExternalDirectory,
    }),
  ),
  prompt: PROMPT_REVIEW,
},
```

with `import PROMPT_REVIEW from "./agent/prompt/review.txt"` near the other prompt imports. Then in `packages/opencode/src/command/index.ts:85` change `agent: "explore"` → `agent: "review"`.

- [ ] **Step 5: Run test to verify it passes**

Run from `packages/opencode`: `bun test ./test/command/review-command.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run from `packages/opencode`: `bun typecheck`. Then:

```bash
git add packages/opencode/src/agent/prompt/review.txt packages/opencode/src/agent/agent.ts packages/opencode/src/command/index.ts packages/opencode/test/command/review-command.test.ts
git commit -m "feat(core): add dedicated read-only review agent for /review"
```

---

### Task 3: Wire `reviewPresetArgs` into the app detached-review path [item 8]

**Files:**
- Modify: `packages/app/src/pages/session/review-detached.ts` (`buildDetachedReviewText`)
- Modify: `packages/app/src/pages/session.tsx` (`args` computation ~L1286–1292 — only if needed for parity)
- Test: `packages/app/src/pages/session/review-detached.test.ts` (extend)

**Interfaces:**
- Consumes: `reviewPresetArgs` from `packages/opencode/src/command/review-preset.ts` — but packages/app must not import from packages/opencode runtime. **Resolve this by inlining the 7-line pure function into `review-detached.ts` as `presetArgs(preset, target)` with a comment pointing at the server twin, and extend BOTH unit tests in lockstep** (`packages/opencode/test/command/review-preset.test.ts` already pins the server side). Rationale: cross-package runtime imports violate the dependency direction (Core/Server not importable from app shell).
- Produces: `presetArgs(preset: "uncommitted" | "base-branch" | "commit", target?: string): string`.

- [ ] **Step 1: Write the failing test**

Extend `packages/app/src/pages/session/review-detached.test.ts`:

```ts
test("presetArgs mirrors the server twin", () => {
  expect(presetArgs("uncommitted")).toBe("")
  expect(presetArgs("base-branch", "main")).toBe("main")
  expect(presetArgs("commit", "abc1234")).toBe("abc1234")
  expect(presetArgs("base-branch", "  ")).toBe("")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/session/review-detached.test.ts`
Expected: FAIL (`presetArgs` not exported).

- [ ] **Step 3: Implement**

In `review-detached.ts`:

```ts
// Mirrors packages/opencode/src/command/review-preset.ts (server twin) —
// kept in app because runtime imports must not cross into packages/opencode.
export function presetArgs(preset: ReviewPreset, target?: string) {
  const trimmed = target?.trim() ?? ""
  if (preset === "base-branch" || preset === "commit") return trimmed
  return ""
}
```

and use it inside `buildDetachedReviewText` in place of any inline arg assembly. Export `ReviewPreset` from the same module (or import as type if the schema package already exports it).

- [ ] **Step 4: Run tests to verify they pass**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/review-detached.ts packages/app/src/pages/session/review-detached.test.ts
git commit -m "refactor(app): share review preset arg assembly via presetArgs"
```

---

### Task 4: One-click "address comments" sends instead of prefilling [item 1]

**Files:**
- Modify: `packages/app/src/pages/session.tsx` (`addressComments` at ~L1251–1269; `followupMutation` at ~L1927 for the send pattern; `queueFollowup` ~L1987)
- Test: `packages/app/src/pages/session/address-comments.test.ts` (new, source-contract style)

**Interfaces:**
- Consumes: `sendFollowupDraft` (`packages/app/src/components/prompt-input/submit.ts:63`, `FollowupDraft` shape at :39), `buildRequestParts` comment-item handling (`build-request-parts.ts:146–195`), `reviewFollowUp` (`review-follow-up.ts:8`), existing i18n keys `session.review.followUp.*`, `session.review.addressComments`.
- Produces: `addressComments(sessionID)` sends a follow-up turn directly when the session is idle; queues via `queueFollowup` when busy. No server changes.

- [ ] **Step 1: Write the failing test**

`packages/app/src/pages/session/address-comments.test.ts` (source-contract style, mirroring `dispatch-panel.test.tsx`):

```ts
import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8")

describe("address comments wiring", () => {
  test("one-click sends a followup draft (or queues when busy)", () => {
    // The addressComments handler must call sendFollowupDraft with the
    // current agent/model, and queueFollowup while the session is busy.
    expect(source).toContain("sendFollowupDraft")
    expect(source).toContain("queueFollowup")
  })
  test("comment context items carry the review selection", () => {
    // Draft context items must set commentOrigin: "review" so
    // buildRequestParts renders the comment notes + file:// parts.
    expect(source).toContain('commentOrigin: "review"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/session/address-comments.test.ts`
Expected: FAIL (`sendFollowupDraft` not present near `addressComments`; current code only does `prompt.set(...)`).

- [ ] **Step 3: Implement**

In `session.tsx`, replace the body of `addressComments` (keep the current `prompt.set` call as the fallback when the session is busy AND the user has a live draft? No — spec says one-click; keep it simple: send-or-queue, no composer touching):

```ts
const addressComments = (sessionID: string) => {
  const all = comments.all()
  if (all.length === 0) return
  const mode = reviewMode()
  // Same synthesized context shape as addCommentToContext, minus touching
  // the live composer: buildRequestParts turns these into comment notes +
  // file:// parts with selection anchors.
  const context = all.map((item) => ({
    key: `comment-${item.id}`,
    type: "file" as const,
    path: item.file,
    selection: item.selection,
    comment: item.comment,
    commentID: item.id,
    commentOrigin: "review" as const,
  }))
  const text = reviewFollowUp({
    header: language.t(
      mode === "turn" ? "session.review.followUp.turn"
        : mode === "git" ? "session.review.followUp.git"
        : "session.review.followUp.branch",
    ),
    comments: [],
  })
  const model = local.model.current()
  const agent = local.agent.current()
  // Busy sessions take the queued path (steer promotion happens at the
  // next safe provider-turn boundary); idle sessions send immediately.
  if (sync().data.session_working(sessionID)) {
    queueFollowup(sessionID, {
      sessionID,
      sessionDirectory: sync().data.directory,
      prompt: [{ type: "text", content: text, start: 0, end: text.length }],
      context,
      agent: agent?.name,
      model: { providerID: model?.providerID, modelID: model?.modelID },
    })
    return
  }
  void sendFollowupDraft({
    api: sdk().api.session,
    draft: {
      sessionID,
      sessionDirectory: sync().data.directory,
      prompt: [{ type: "text", content: text, start: 0, end: text.length }],
      context,
      agent: agent?.name,
      model: { providerID: model?.providerID, modelID: model?.modelID },
    },
    optimisticBusy: true,
  })
}
```

Adapt field names to the actual `FollowupDraft`/queue-item shapes in `submit.ts` and the `followup` store (the queue path's `sendFollowup(...)` at mutation time must resolve identical parts — mirror `followupMutation`'s construction exactly). Notes:
- `reviewFollowUp`'s comment lines are intentionally empty because comment context items are rendered by `buildRequestParts` via `formatCommentNote` — pass the header-only text plus the context items.
- Keep the menu item disabled state (`hasComments()`); the existing key `session.review.addressCommentsDisabled` remains.
- Do NOT prefill the composer anymore; remove the `prompt.set` line once the send/queue path is committed.

- [ ] **Step 4: Run test to verify it passes**

Same command as Step 2. Also re-run `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/components/prompt-input/submit.test.ts` to make sure the send path contract is intact. Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run from `packages/app`: `bun typecheck`. Then:

```bash
git add packages/app/src/pages/session.tsx packages/app/src/pages/session/address-comments.test.ts
git commit -m "feat(app): make address-comments turn review comments into a follow-up"
```

---

### Task 5: Populate retention entries + sweep on archive [item 2]

**Files:**
- Modify: `packages/opencode/src/worktree/index.ts` (`createAndRetain` ~L758–812 entry building at :789–795; extract sweep into an exported service member `retire`)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` (`disposeArchivedWorktree` ~L88–102)
- Test: `packages/opencode/test/worktree/retention.test.ts` (extend), `packages/opencode/test/worktree/retention-live.test.ts` (extend — check existing name; if a live retention test doesn't exist, add `retention-sweep.test.ts`)

**Interfaces:**
- Consumes: `worktreesToRemove(entries, limit)` (retention.ts:10), `boundSessions` (bound-sessions.ts:26), `shouldDispose` (session-binding.ts), `Worktree.Service.list`.
- Produces: `Worktree.Service.retire()` — `Effect.Effect<void, Error>` — sweeps owned worktrees using enriched entries; called from `createAndRetain` AND from `disposeArchivedWorktree`.

- [ ] **Step 1: Write the failing test**

New file `packages/opencode/test/worktree/retention-sweep.test.ts`, modeled on `test/worktree/handoff.test.ts` harness (`testEffect` + `LayerNode.compile` + `it.instance(..., { git: true })`):

```ts
it.instance("disposable worktrees beyond keep are retired on sweep", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const svc = yield* Worktree.Service
    // created entries must carry disposable/lastUsedAt once bound sessions exist
    const info = yield* svc.createDisposable({ sessionID: "sess_1" })
    const entries = yield* entrySource // the exposed enriched-entries accessor
    const mine = entries.find((entry) => entry.directory === info.directory)
    expect(mine?.disposable).toBe(true)
    expect(mine?.lastUsedAt).toBeGreaterThan(0)
    yield* svc.retire()
    expect(yield* svc.remove({ directory: info.directory })).toBe(true)
  }), { git: true })
```

Plus pure additions in `test/worktree/retention.test.ts`:

```ts
test("disposable entries are evicted by recency like any other", () => {
  const entries = [ /* 16 entries; #0 has lastUsedAt now-1, others spread hourly, disposable set on #0 */ ]
  expect(worktreesToRemove(entries, 15)).toEqual([entries[15].directory])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/opencode`: `bun test ./test/worktree/retention-sweep.test.ts ./test/worktree/retention.test.ts`
Expected: FAIL — `retire` not on the Service; entries lack `disposable`/`lastUsedAt`.

- [ ] **Step 3: Implement**

1. In `worktree/index.ts`, extract the removal sweep from `createAndRetain` (the `worktreesToRemove` → `retire` sequence at ~L789–846) into `readonly retire: Effect.Effect<void, Error>` on `Service`, which:
   - builds entries via `list()`, then enriches each with `disposable` and `lastUsedAt` by querying bound sessions (`boundSessions(sessions, entry.directory)` — derive `disposable: true` from any bound session metadata `disposable === true`, `lastUsedAt` from the newest bound session's `time.updated`),
   - protects `open`/`running` (already the case in `worktreesToRemove`),
   - calls the non-destructive `retire` path for the winners (unchanged behavior).
2. `createAndRetain` now calls `svc.retire()` after creating (replacing its inline sweep).
3. In `handlers/session.ts` `disposeArchivedWorktree`, after the per-session dispose call, fire `worktreeSvc.retire()` best-effort (`Effect.ignore`), so keep-N is enforced when sessions archive, not only on creation.

- [ ] **Step 4: Run tests to verify they pass**

Run from `packages/opencode`: `bun test ./test/worktree/` (full dir). Expected: PASS (retention ordering tests keep asserting that disposable entries are NOT evicted-first — do not change that semantics).

- [ ] **Step 5: Typecheck + commit**

Run from `packages/opencode`: `bun typecheck`. Then:

```bash
git add packages/opencode/src/worktree/index.ts packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts packages/opencode/test/worktree/
git commit -m "feat(worktree): enforce keep-N retention on archive and populate disposable entries"
```

---

### Task 6: Local ↔ Worktree handoff with opt-in rebind flag [item 2]

**Files:**
- Modify: `packages/core/src/v1/config/config.ts` (~L104–117, `worktree` block)
- Modify: `packages/opencode/src/config/worktree.ts` (`settings()` + `defaults`)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts` (`rebindHandoffSessions` guards at ~L158–160, and complete the primary-switch sequence from `handlers/session.ts:503–541`)
- Modify: `packages/app/src/pages/layout/sidebar-workspace.tsx` (`handoffTo` ~L1045–1067 — offer "Local" as target when flag on)
- Test: `packages/opencode/test/worktree/handoff-rebind.test.ts` (extend)

**Interfaces:**
- Consumes: `SessionV2.setDirectory`, `projectDirectories.create`, `sessionFolders.replace`, `liveFolders.refresh`, `instances.reload` (the `updateFolders` primary-switch recipe, `handlers/session.ts:503–541`); `Worktree.handoff`.
- Produces: config `worktree.allow_primary_rebind?: boolean` (snake_case, tolerant decode, default `false`).

- [ ] **Step 1: Write the failing test**

Extend `packages/opencode/test/worktree/handoff-rebind.test.ts` (full arrangement using the exact fixture helpers that file already imports — `testEffect` + `LayerNode.compile` + `it.instance(..., { git: true })`):

```ts
it.instance("rebinds sessions off the primary when allow_primary_rebind is set", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const sessions = yield* SessionV2 // same access pattern handoff-rebind.test.ts uses today
    const worktrees = yield* Worktree.Service
    // 1. write a test config with worktree.allow_primary_rebind = true the
    //    way test/worktree/config.test.ts loads tolerant settings
    // 2. create a disposable worktree and record its directory
    const info = yield* worktrees.createDisposable({ sessionID: "sess_local" })
    // 3. create and bind a session to the primary checkout directory
    const session = yield* sessions.create({})
    yield* sessions.setDirectory({ sessionID: session.id, directory: test.directory })
    // 4. invoke the handoff handler exactly as handoff.test.ts does for
    //    worktree→worktree (httpApiLayer + requestInDirectory), Local → worktree
    const rebound = (yield* sessions.listGlobal({ directory: test.directory, archived: true, limit: 1 }))
    expect(rebound.length).toBe(0) // session row followed the handoff off-Local
  }), { git: true })
```

The arrangement uses only APIs the existing test files already exercise; if accessor names differ in this file's current imports, mirror those — the behavioral assertions (session row re-homed, default-off refusal) are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/opencode`: `bun test ./test/worktree/handoff-rebind.test.ts`
Expected: FAIL — the primary-source guard refuses rebinding.

- [ ] **Step 3: Implement**

1. Config: add `allow_primary_rebind?: Schema.optional(Schema.Boolean)` inside the `worktree` struct (`core/src/v1/config/config.ts:104–117`); in `packages/opencode/src/config/worktree.ts`, extend `settings()` with `allowPrimaryRebind: cfg.allow_primary_rebind === true` (tolerant default) and add to `defaults` (`false`).
2. Handler: in `rebindHandoffSessions`, allow `from`-is-primary when `settings().allowPrimaryRebind` is true (keep the serving-instance guard at :160 — that one stays fatal). When rebinding across checkouts, run the full primary-switch sequence from `updateFolders` (setDirectory → projectDirectories.create → sessionFolders.replace → liveFolders.refresh → instances.reload) instead of bare `setDirectory`.
3. App: in `sidebar-workspace.tsx`, when `settings` exposes the resolved flag through the existing worktree settings plumbing (`packages/app/src/components/settings-v2/worktree.tsx` read path), render the "Local" entry as a handoff target into `handoffTo` (occupied-target guard at :1041–1044 already covers downstream safety), and after a successful handoff re-bootstrap the routed client following `submit.ts:469–475` (`serverSync().child(newDirectory)` → `createClient({ directory })` → navigate).
4. Because the config schema is inside packages/schema/core decode paths only (no HttpApi change), no SDK regen is required; if typegen complains, run `bun run generate` from `packages/client`.

- [ ] **Step 4: Run tests to verify they pass**

Run from `packages/opencode`: `bun test ./test/worktree/` — including existing `handoff.test.ts` (the worktree→worktree path must be unchanged when flag is off; default stays refusal). Expected: PASS.

- [ ] **Step 5: Typecheck (both packages) + commit**

`bun typecheck` from `packages/opencode` and `packages/app`. Then:

```bash
git add packages/core/src/v1/config/config.ts packages/opencode/src/config/worktree.ts packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts packages/app/src/pages/layout/sidebar-workspace.tsx packages/opencode/test/worktree/handoff-rebind.test.ts
git commit -m "feat(worktree): opt-in local rebind for checkout handoff"
```

---

### Task 7: Routine rows show running state in the activity inbox [item 3]

**Files:**
- Modify: `packages/app/src/pages/dispatch/activity-inbox-rows.ts` (`routineRows` ~L41–58 — never-hardcoded `done`)
- Modify: `packages/app/src/pages/dispatch/activity-inbox.tsx` (pass a liveness lookup into `routineRows`)
- Test: `packages/app/src/pages/dispatch/activity-inbox-rows.test.ts` (extend)

**Interfaces:**
- Consumes: `StoredRoutine.recentRuns[].sessionID` (settings-v2/routines-edit.ts:1–7), `serverSync().session.data.session_status` / `api.session.active()` liveness patterns (activity-inbox.tsx:88–98), `InboxRow`/`rank` (activity-inbox-rows.ts:5–14, 77–90).
- Produces: `routineRows(routines, isLive)` — new second parameter `isLive: (sessionID: string) => boolean`.

- [ ] **Step 1: Write the failing test**

Extend `packages/app/src/pages/dispatch/activity-inbox-rows.test.ts`:

```ts
test("routine row is running when its latest run's session is live", () => {
  const routines = [fakeRoutine({ recentRuns: [{ sessionID: "sess_9", startedAt: 0, endedAt: 0, state: "ok" }] })]
  const rows = routineRows(routines, (id) => id === "sess_9")
  expect(rows[0].status).toBe("running")
})

test("routine row stays done when the latest run's session is idle", () => {
  const routines = [fakeRoutine({ recentRuns: [{ sessionID: "sess_9", startedAt: 0, endedAt: 0, state: "ok" }] })]
  const rows = routineRows(routines, () => false)
  expect(rows[0].status).toBe("done")
})
```

(`fakeRoutine` is whatever helper the existing tests already use to construct `StoredRoutine` — mirror its construction.)

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/dispatch/activity-inbox-rows.test.ts`
Expected: FAIL (`routineRows` takes one argument / always yields `done`).

- [ ] **Step 3: Implement**

```ts
export function routineRows(routines: StoredRoutine[], isLive: (sessionID: string) => boolean): InboxRow[] {
  return routines.map((routine) => {
    const latest = routine.recentRuns?.at(-1)
    const status = latest?.state === "error" ? "failed"
      : latest && isLive(latest.sessionID) ? "running"
      : "done"
    // ...rest unchanged (unread derivation: failed or transitioning-to-terminal)
  })
}
```

Update the call site in `activity-inbox.tsx` to pass the same liveness callback style used for dispatch reconciliation (`serverSDK().api.session.active()` result or `serverSync().session.data.session_status[sessionID]?.type` not idle-or-undefined — reuse `waitingFor`'s patterns where needed). Also update `inboxRowStatus`'s unused `kind` only if needed to preserve this mapping (currently `void kind` at activity-status.ts:36 — leave as-is unless the mapping leaks).

- [ ] **Step 4: Run tests to verify they pass**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/dispatch/activity-inbox-rows.ts packages/app/src/pages/dispatch/activity-inbox.tsx packages/app/src/pages/dispatch/activity-inbox-rows.test.ts
git commit -m "feat(app): show live routine runs in the activity inbox"
```

---

### Task 8: Wire `blockedBySandbox` into the permission dock [item 4a]

**Files:**
- Modify: `packages/app/src/pages/session/composer/session-composer-region.tsx` (~L70–86 props pass-through)
- Modify: `packages/app/src/pages/session/session-composer-state.ts` (add `permissionSandboxBlocked` derive)
- Test: `packages/app/src/pages/session/session-composer-state.test.ts` (extend at ~L353–372)

**Interfaces:**
- Consumes: `session-permission-dock.tsx` props `blockedBySandbox` (declared :39, rendered :116–133, i18n `approval.sandboxBlocked.*`), `permissionSandboxLevel` (`permission.tsx:341–350`), pending permission data (`sync().data.permission[id]`).
- Produces: `permissionSandboxBlocked(directory, permission)` — boolean.

- [ ] **Step 1: Write the failing test**

Extend `packages/app/src/pages/session/session-composer-state.test.ts`:

```ts
test("sandbox blockers are derived for bash and write tools under readonly", () => {
  expect(permissionSandboxBlocked("readonly", "bash")).toBe(true)
  expect(permissionSandboxBlocked("readonly", "edit")).toBe(true)
  expect(permissionSandboxBlocked("workspace-write", "bash")).toBe(false)
  expect(permissionSandboxBlocked("full-access", "bash")).toBe(false)
  expect(permissionSandboxBlocked("readonly", "read")).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/session/session-composer-state.test.ts`
Expected: FAIL (function not exported).

- [ ] **Step 3: Implement**

In `session-composer-state.ts`:

```ts
// Prospective badge: under readonly the server hard-denies bash and write
// tools (SandboxViolationError at session/tools.ts:98–114), so a pending
// ask of those kinds cannot be granted without a sandbox change.
export function permissionSandboxBlocked(
  level: "readonly" | "workspace-write" | "full-access",
  permission: string,
): boolean {
  // level/permission only, matching the test above — pending ask patterns are
  // not needed because readonly + bash/edit is a whole-tool denial upstream.
  if (level !== "readonly") return false
  return permission === "bash" || permission === "edit"
}
```

In `session-composer-region.tsx`, pass `blockedBySandbox: permissionSandboxBlocked(permissionSandbox(directory), pendingKind)` where `pendingKind` comes from the first pending permission request's kind (mirror how the dock already reads `data.permission[id]`). Leave `reviewerApproved` unwired until Task 10.

- [ ] **Step 4: Run tests to verify they pass**

Same command as Step 2, plus `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/pages/session/composer/session-permission-dock.test.tsx`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/session-composer-state.ts packages/app/src/pages/session/session-composer-region.tsx packages/app/src/pages/session/session-composer-state.test.ts
git commit -m "feat(app): badge sandbox-blocked permission requests in the dock"
```

---

### Task 9: Trigger the `permission.ask` plugin hook [item 4a]

**Files:**
- Modify: `packages/opencode/src/plugin/index.ts` (hook aggregation ~L320–354 — add `"permission.ask"` deny-wins trigger)
- Modify: `packages/plugin/src/index.ts` (hook type `Hooks.permission.ask` already declared at :261 — verify shape)
- Modify: `packages/opencode/src/permission/index.ts` (ask path — invoke plugin hooks before pending-prompt creation)
- Test: `packages/opencode/test/permission/permission-ask-hook.test.ts` (new)

**Interfaces:**
- Consumes: plugin `triggerDecision` pattern for `"tool.permission"` (opencode/src/plugin/index.ts:320–354, aggregate deny-wins).
- Produces: plugin hooks of kind `permission.ask` can `deny` (or `allow`) a permission request before the user prompt is created. Ask payload: `{ permission, patterns, sessionID, tool, args }`.

- [ ] **Step 1: Write the failing test**

`packages/opencode/test/permission/permission-ask-hook.test.ts` — mirror `test/permission/permission-request-hook.test.ts`'s harness (plugin hook fixture + Permission service resolution):

```ts
// A plugin whose permission.ask hook returns { decision: "deny" } causes
// Permission.ask to fail with DeniedError without publishing an ask event.
it.effect("plugin permission.ask deny short-circuits the prompt", () =>
  Effect.gen(function* () {
    const error = yield* failOf(permission.ask({ permission: "bash", patterns: ["git *"], ... }))
    expect(error instanceof PermissionV1.DeniedError).toBe(true)
  }))
```

(Setup: register a test plugin with the hook, mirroring how `permission-request-hook.test.ts` installs the file-config hook; the assertion is that the plugin decision wins over the ask prompt.)

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/opencode`: `bun test ./test/permission/permission-ask-hook.test.ts`
Expected: FAIL — no `permission.ask` trigger exists.

- [ ] **Step 3: Implement**

In `packages/opencode/src/plugin/index.ts`, extend the trigger aggregation (~L320–354) to accept `permission.ask` events with the deny-wins aggregation used by `tool.permission` (a plugin returning `allow` is a no-op; only `deny` and `ask`-to-user decisions matter). In `packages/opencode/src/permission/index.ts` `Service.ask`, run the plugin trigger right after the deny/allow rule evaluation but BEFORE `hooksRunner.runPermissionRequest` (~L110) and before the pending prompt is created; a plugin deny fails with the existing `PermissionV1.DeniedError`.

- [ ] **Step 4: Run tests to verify they pass**

Run from `packages/opencode`: `bun test ./test/permission/` — full dir, including `permission-request-hook.test.ts` (file-config hooks keep denying) and `computer-use-guard.test.ts`. Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

`bun typecheck` from `packages/opencode`, then validate plugin SDK surface: `bun typecheck` from `packages/plugin`. Then:

```bash
git add packages/opencode/src/plugin/index.ts packages/opencode/src/permission/index.ts packages/plugin/src/index.ts packages/opencode/test/permission/permission-ask-hook.test.ts
git commit -m "feat(plugin): invoke permission.ask plugin hook before permission prompts"
```

---

### Task 10: LLM auto-reviewer for `approval: "auto"` [item 4b]

**Files:**
- Modify: `packages/opencode/src/permission/reviewer.ts` (accept `{ tool, args }`, keep the static AUTO_ALLOW fast path)
- Create: `packages/opencode/src/permission/auto-reviewer.ts` (agent-backed reviewer service)
- Modify: `packages/opencode/src/agent/agent.ts` (hidden `auto-review` agent, mirroring `compaction`/`title` at :265–295)
- Modify: `packages/opencode/src/session/tools.ts` (`ctx.ask` at :94–128 — auto-review gate between the static reviewer (:115) and `permission.ask` (:118))
- Test: `packages/opencode/test/permission/auto-reviewer.test.ts` (new), extend `test/permission/reviewer.test.ts`

**Interfaces:**
- Consumes: `Reviewer.review` static allowlist; hidden-agent pattern (`agent.ts` `hidden: true`, `"*": "deny"`); the LLM one-shot invocation used by the title/summary hidden agents (`src/session/prompt.ts` title-generation path) — mirror that call shape.
- Produces: `AutoReviewer.request(input: { sessionID, tool, args, permission, patterns }) => Effect<"allow" | "deny" | "defer">`.

- [ ] **Step 1: Write the failing test**

```ts
// auto-reviewer.test.ts
it.effect("defers when the reviewer agent is unavailable or fails", () =>
  Effect.gen(function* () {
    const reviewer = yield* AutoReviewer.node // layer with a failing/dummy LLM stub
    const verdict = yield* reviewer.request({ sessionID, tool: "bash", args: "git status", permission: "bash", patterns: ["git *"] }).pipe(Effect.either)
    expect(Either.isRight(verdict) && verdict.right === "defer").toBe(true)
  }))

it.effect("deny verdict fails closed as DeniedError downstream", () =>
  Effect.gen(function* () {
    // session.tools ctx.ask with approval "auto" + stubbed reviewer deny
    // → SandboxViolation-style deny, NOT an auto-approval.
    expect(denied).toBe(true)
  }))
```

Fill the harness from the existing `test/permission/approval-mode.test.ts` fixtures (it already stubs approval modes) and the reviewer stub style from `test/session/tools.test.ts`. Also extend `reviewer.test.ts` for the enriched input:

```ts
test("review receives tool and args for AUTO_ALLOW decisions", () => {
  expect(Reviewer.review({ permission: "read", patterns: ["*"], ruleset, tool: "read", args: {} })).toBe("allow")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/opencode`: `bun test ./test/permission/auto-reviewer.test.ts ./test/permission/reviewer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. `reviewer.ts`: extend `review`'s input with optional `tool`/`args` (pure, no behavior change to AUTO_ALLOW logic — fields exist so the gate site can pass full context, and so a richer static rule can use them later).
2. `auto-reviewer.ts`: `AutoReviewer.Service` with `request(input)` → `Effect<"allow" | "deny" | "defer">`. It renders the hidden `auto-review` agent prompt with a compact JSON payload of `{ tool, args, permission, patterns }` and a strict output contract, parses the reply for `VERDICT: allow|deny`, and returns `defer` on any parse/transport failure (fail-open to the normal ask prompt, never fail-open to approval).
3. `agent.ts`: hidden `auto-review` agent mirroring the `compaction` shape (:265–279): `mode: "primary"`, `native: true`, `hidden: true`, `permission: Permission.merge(defaults, Permission.fromConfig({ "*": "deny" }))`, prompt text inlined as a constant ("You authorise tool use... respond only with VERDICT: allow or VERDICT: deny plus one line of reason").
4. `tools.ts`: in the `ctx.ask` closure, when configured approval is `"auto"` and the request reaches the ask path (i.e., after static reviewer `defer`), call `AutoReviewer.request`; `allow` → `Effect.void`; `deny` → `Effect.fail(new PermissionV1.DeniedError(...))`; `defer` → fall through to `permission.ask` unchanged. The verdict additionally lands in `Event.Asked` payload (add optional `reviewer: "allow" | "deny" | "defer"` to `AskInput`) so Task 11/8's `reviewerApproved` dock prop can be wired.

- [ ] **Step 4: Run tests to verify they pass**

Run from `packages/opencode`: `bun test ./test/permission/ ./test/session/tools.test.ts`
Expected: PASS — including existing `approval-mode.test.ts` (approval `"auto"` semantics now go through the reviewer; its existing fixtures must be updated only if they assert unconditional auto-approval of non-ALWAYS_ASK tools — adjust those fixtures to stub the reviewer with `allow`).

- [ ] **Step 5: Typecheck + commit**

Run from `packages/opencode` and `packages/core`: `bun typecheck`. Then:

```bash
git add packages/opencode/src/permission/reviewer.ts packages/opencode/src/permission/auto-reviewer.ts packages/opencode/src/agent/agent.ts packages/opencode/src/session/tools.ts packages/opencode/test/permission/
git commit -m "feat(permission): agent-backed auto reviewer for approval auto mode"
```

---

### Task 11: Settings permissions page with hidden full-access [item 4c]

**Files:**
- Create: `packages/app/src/components/settings-v2/permissions.tsx`
- Modify: `packages/app/src/components/settings-v2/dialog-settings-v2.tsx` (register the section)
- Modify: `packages/app/src/i18n/en.ts` + `packages/app/src/i18n/flynncode-fallback.ts` (keys registration)
- Test: `packages/app/src/components/settings-v2/permissions.test.tsx` (new, source-contract style)

**Interfaces:**
- Consumes: server config write path (`writable()`/`writableGlobal()` config patch pattern, `packages/app/src/context/...` — mirror how `settings-v2/worktree.tsx` writes `worktree.*` via the settings form machinery); `sandboxLevel` read pattern (`permission.tsx:341–350`); danger-confirmation idiom (`session-worktree-menu.tsx:23`, `variant="danger"` cards in `settings-v2/*`).
- Produces: settings page exposing approval mode (manual / accept-edits / auto) and sandbox level (readonly / workspace-write / **full-access hidden behind an explicit confirmation**), writing `permission.approval` / `permission.sandbox` in server config.

- [ ] **Step 1: Write the failing test**

`permissions.test.tsx` (source-contract; DOM does not work under `--conditions=solid` for these dialogs — mirror `dialog-connect-provider-muse.test.ts`):

```ts
const source = readFileSync(new URL("./permissions.tsx", import.meta.url), "utf8")

describe("settings permissions page", () => {
  test("writes server config keys for approval and sandbox", () => {
    expect(source).toContain('"approval"')
    expect(source).toContain('"sandbox"')
  })
  test("full-access is confirmation-gated", () => {
    expect(source).toContain("settings.permissions.fullAccess.confirm")
    expect(source).toContain('variant="danger"')
  })
  test("registered in the settings dialog", () => {
    const dialog = readFileSync(new URL("./dialog-settings-v2.tsx", import.meta.url), "utf8")
    expect(dialog).toContain("./permissions")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/app`: `bun test --isolate --conditions=solid --preload ./happydom.ts ./src/components/settings-v2/permissions.test.tsx`
Expected: FAIL (file absent).

- [ ] **Step 3: Implement**

1. `permissions.tsx`: a settings card modeled on `settings-v2/worktree.tsx` — approval-mode segmented control (`manual` | `accept-edits` | `auto`), sandbox select (`readonly` | `workspace-write`), and a full-access option rendered as a `danger` button with a `ConfirmDialog` (copy: enabling full access removes write containment for every running session). Writes go through the same server-config patch path the worktree settings card uses (`permission: { approval, sandbox }` whole-value replace semantics — see `config.ts:159–185`).
2. Register the card in `dialog-settings-v2.tsx` nav following the existing section entries.
3. i18n keys: `settings.permissions.approval.label`, `.manual`, `.acceptEdits`, `.auto`, `.auto.description`, `settings.permissions.sandbox.label`, `.readonly`, `.workspace`, `settings.permissions.fullAccess.button`, `.confirm.title`, `.confirm.body`, `.confirm.accept` — English source in `en.ts`, then register the key names in `flynncode-fallback.ts` keys array.

- [ ] **Step 4: Run tests to verify they pass**

Same command as Step 2, plus the app i18n parity test if present (`packages/app/src/i18n/parity.test.ts`). Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run from `packages/app`: `bun typecheck`. Then:

```bash
git add packages/app/src/components/settings-v2/permissions.tsx packages/app/src/components/settings-v2/dialog-settings-v2.tsx packages/app/src/i18n/en.ts packages/app/src/i18n/flynncode-fallback.ts packages/app/src/components/settings-v2/permissions.test.tsx
git commit -m "feat(app): permission settings page with confirmation-gated full access"
```

---

## Deferred (deliberately out of this phase plan)

- **TUI preset menu for `/review`** — the TUI tip text already documents presets; a preset dropdown in TUI is deferred until the app-side review reflow settles (item 8 remainder).
- **Routine run-history HTTP endpoint** (`routines-runs.jsonl` exposure) — belongs with Phase 3 item 6 (RRULE + run history).
- **Sandbox enforcement at the tool-execution layer + child-process containment (Seatbelt/Landlock)** — the plan keeps ask-time path containment; OS sandboxing is a separate spec (spec risk #1).
- **Dock `reviewerApproved` wiring** — completes in Task 10 step 3 (verdict lands in `Event.Asked`); the dock prop already renders, so wiring is a one-line follow-up once the verdict field exists; folded into Task 10's commit.
- **Inbox page-ification** (dialog → route) — current dialog entry serves both layouts; re-evaluate with the new-layout workstream.

## Verification (phase gate)

Run after Task 11:

```bash
# from packages/opencode
bun typecheck && bun test ./test/permission/ ./test/worktree/ ./test/command/
# from packages/app
bun typecheck && bun run test:unit
# from packages/core
bun typecheck
```

Manual smoke: subagent stop/steer on a worktree-isolated child; `/review` via app preset dropdown (attached + detached); one-click address-comments on an idle session; worktree create → archive → retention sweep; inbox routine running state; permission dock on readonly sandbox; plugin deny via permission.ask hook; settings permissions page full-access confirm.