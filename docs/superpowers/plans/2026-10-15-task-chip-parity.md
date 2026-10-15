# Task-Chip Parity Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the raw `<task-suggestion>` envelope from settled assistant body text (chip becomes its only representation) and show a toast when a chip is clicked in a project with no worktree.

**Architecture:** Render-layer only. A pure `TaskSuggestion.strip` helper trims a trailing envelope; the row builder flags the envelope-bearing `AssistantPart` row; the timeline renderer passes a stripped part copy to the unchanged shared `MessagePart`. The durable transcript, `session-ui`, and prompt guidance are untouched.

**Tech Stack:** TypeScript, SolidJS (app), bun test with happydom + solid conditions, `tsgo` typecheck.

## Global Constraints

- Run tests from package dirs only: `packages/app` for all commands below. Never run tests from the repo root.
- Run `bun run typecheck` in `packages/app` after the last code change (Task 3 and Task 4 touch production code).
- Conventional commits: `feat(app): <summary>` for code tasks.
- NEVER hardcode user-visible English in production code: all copy via `language.t(...)`; new keys go in `packages/app/src/i18n/en.ts` AND `packages/app/src/i18n/flynncode-fallback.ts` (bare string in the `keys` array).
- No new runtime dependencies. No changes to `packages/session-ui`, `packages/flynncode`, cloud/web surfaces, or notification code.
- Work on the `task-chip-parity` branch (spec commit `80f5a6094e` is already there).

---

## File structure

- `packages/app/src/pages/session/timeline/rows.ts` — owns the `TaskSuggestion` namespace (`parse`, new `strip`) and `constructMessageRows` (computes the suggestion, flags the source row). Also owns `TimelineRowMap["AssistantPart"]` (view type used by the renderer).
- `packages/app/src/pages/session/timeline/timeline-row.ts` — owns the `TimelineRow.AssistantPart` `Data.TaggedClass` (runtime row shape).
- `packages/app/src/pages/session/timeline/message-timeline.tsx` — owns `renderAssistantPartGroup` (applies the strip) and `startTaskSession` (no-worktree toast).
- `packages/app/src/pages/session/timeline/task-chips.test.ts` — unit tests for `strip` and the row flag.
- `packages/app/src/pages/session/timeline/task-chip-source.test.ts` — source-contract tests for renderer wiring and the toast branch.
- `packages/app/src/i18n/en.ts` + `packages/app/src/i18n/flynncode-fallback.ts` — the two new toast copy keys.

---

### Task 1: `TaskSuggestion.strip` helper plus unit tests

**Files:**
- Modify: `packages/app/src/pages/session/timeline/rows.ts` (add `strip` to the `TaskSuggestion` namespace, after `parse`, before `fromParts`)
- Test: `packages/app/src/pages/session/timeline/task-chips.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `TaskSuggestion.strip(text: string): string` — removes one trailing `<task-suggestion …>…</task-suggestion>` block plus preceding trailing whitespace; returns the input unchanged when there is no envelope or the envelope is not trailing (only whitespace may follow it). Used by Task 3. Note: `parse` reads the FIRST envelope while `strip` removes the TRAILING one; they agree in the normal single-envelope case the model guidance requires.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block at the end of `packages/app/src/pages/session/timeline/task-chips.test.ts` (inside the file, after the last `describe`):

```ts
describe("task-chip envelope strip", () => {
  test("removes a trailing envelope and keeps the prose", () => {
    expect(
      TaskSuggestion.strip(
        'Done.\n<task-suggestion title="Extract helper" prompt="Extract the shared helper">Separable cleanup.</task-suggestion>',
      ),
    ).toBe("Done.")
  })

  test("removes the blank line before a trailing envelope", () => {
    expect(
      TaskSuggestion.strip(
        'Done.\n\n<task-suggestion title="T" prompt="P">n</task-suggestion>',
      ),
    ).toBe("Done.")
  })

  test("reduces an envelope-only reply to empty", () => {
    expect(TaskSuggestion.strip('<task-suggestion title="T" prompt="P">n</task-suggestion>')).toBe("")
  })

  test("leaves a mid-text envelope untouched", () => {
    const text = 'A <task-suggestion title="T" prompt="P">n</task-suggestion> B'
    expect(TaskSuggestion.strip(text)).toBe(text)
  })

  test("passes text without an envelope through", () => {
    expect(TaskSuggestion.strip("plain answer")).toBe("plain answer")
  })
})
```

`TaskSuggestion` is already imported in that file (line 15 destructures it from `./rows`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --isolate --conditions=solid --only-failures --preload ./happydom.ts ./src/pages/session/timeline/task-chips.test.ts`
Expected: FAIL with `TaskSuggestion.strip is not a function` (5 failing tests, all existing tests pass).

- [ ] **Step 3: Write the minimal implementation**

In `packages/app/src/pages/session/timeline/rows.ts`, inside `export namespace TaskSuggestion`, after the closing brace of `parse` (line 58) and before the `fromParts` comment (line 60), insert:

```ts
  // Removes a trailing suggestion envelope (plus preceding trailing
  // whitespace) from assistant body text. The chip row is the envelope's
  // only visible representation once the turn settles, so the body keeps
  // just the prose. A non-trailing envelope is left alone.
  export const strip = (text: string): string => {
    const pattern = /<task-suggestion\b[^>]*>[\s\S]*?<\/task-suggestion>/g
    let last: RegExpExecArray | undefined
    for (const match of text.matchAll(pattern)) last = match
    if (!last) return text
    if (text.slice(last.index + last[0].length).trim() !== "") return text
    return text.slice(0, last.index).replace(/\s*$/, "")
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test --isolate --conditions=solid --only-failures --preload ./happydom.ts ./src/pages/session/timeline/task-chips.test.ts ./src/pages/session/timeline/task-chip-source.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/timeline/rows.ts packages/app/src/pages/session/timeline/task-chips.test.ts
git commit -m "feat(app): strip trailing task-suggestion envelope helper"
```

---

### Task 2: Flag the envelope-bearing row at construction time

**Files:**
- Modify: `packages/app/src/pages/session/timeline/timeline-row.ts` (add optional field to `AssistantPart`)
- Modify: `packages/app/src/pages/session/timeline/rows.ts` (`TimelineRowMap["AssistantPart"]`, `taskSuggestionFromMessages` return shape, hoisted suggestion computation, flag on the matching row push)
- Test: `packages/app/src/pages/session/timeline/task-chips.test.ts` (new tests in the `task-chip timeline rows` describe)

**Interfaces:**
- Consumes: `TaskSuggestion.strip` is NOT used here (Task 3 uses it).
- Produces: `hideTrailingSuggestion?: boolean` on BOTH `TimelineRow.AssistantPart` (runtime class) and `TimelineRowMap["AssistantPart"]` (renderer view type) — same name, same meaning: this row's text part ends with the turn's suggestion envelope. Plus `taskSuggestionFromMessages` now returns `{ suggestion: TaskSuggestion.Suggestion; messageID: string; partID: string } | undefined` so the builder can match the source row by `group.ref`. Task 3 consumes the flag.

- [ ] **Step 1: Write the failing tests**

Append two tests inside the existing `describe("task-chip timeline rows", ...)` block in `packages/app/src/pages/session/timeline/task-chips.test.ts` (before its closing `})` at line 176):

```ts
  test("flags the text row carrying the envelope", () => {
    const source = [
      { id: "msg_u", type: "user", text: "do the main task", time: { created: 1 } },
      {
        id: "msg_a",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "text",
            text: 'Done.\n<task-suggestion title="Extract helper" prompt="Extract the shared helper into its own module">Separable cleanup.</task-suggestion>',
          },
        ],
        time: { created: 2, completed: 3 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "idle",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    const assistant = result.rows.find((row) => row._tag === "AssistantPart")
    expect(assistant?._tag).toBe("AssistantPart")
    if (assistant?._tag !== "AssistantPart") return
    expect(assistant.hideTrailingSuggestion).toBe(true)
    const chip = result.rows.at(-1)
    expect(chip?._tag).toBe("TaskSuggestion")
    if (chip?._tag !== "TaskSuggestion") return
    expect(chip.title).toBe("Extract helper")
  })

  test("no flag on rows without an envelope", () => {
    const source = [
      { id: "msg_u", type: "user", text: "hi", time: { created: 1 } },
      {
        id: "msg_a",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "plain answer" }],
        time: { created: 2, completed: 3 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "idle",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    const assistant = result.rows.find((row) => row._tag === "AssistantPart")
    expect(assistant?._tag).toBe("AssistantPart")
    if (assistant?._tag !== "AssistantPart") return
    expect(assistant.hideTrailingSuggestion).toBeUndefined()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --isolate --conditions=solid --only-failures --preload ./happydom.ts ./src/pages/session/timeline/task-chips.test.ts`
Expected: FAIL — TypeScript error `Property 'hideTrailingSuggestion' does not exist` on both assertions (bun test type-strips without typechecking, so the failure surfaces as `expect(undefined).toBe(true)` failing on the first test; either way both new tests fail while all existing tests pass).

- [ ] **Step 3: Write the minimal implementation**

Edit 1 — `packages/app/src/pages/session/timeline/timeline-row.ts`, extend the `AssistantPart` class fields:

```ts
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    // Verbose view mode: tool parts in this group render with details forced open.
    verbose?: boolean
    // Set when this part's text ends with the turn's task-suggestion envelope;
    // the renderer strips the envelope so the chip is its only representation.
    hideTrailingSuggestion?: boolean
  }> {}
```

Edit 2 — `packages/app/src/pages/session/timeline/rows.ts`, extend the `TimelineRowMap` entry (same optional field, same comment):

```ts
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    verbose?: boolean
    // Set when this part's text ends with the turn's task-suggestion envelope;
    // the renderer strips the envelope so the chip is its only representation.
    hideTrailingSuggestion?: boolean
  }
```

Edit 3 — `packages/app/src/pages/session/timeline/rows.ts`, change `taskSuggestionFromMessages` to also return the source part ref:

```ts
  // First task-suggestion envelope across a turn's assistant messages, in
  // chronological order; later messages win only when earlier ones lack one.
  // Returns the source part ref alongside the suggestion so the row builder
  // can mark the exact row for envelope stripping.
  export const taskSuggestionFromMessages = (
    assistantMessages: readonly AssistantMessage[],
    getMessageParts: (messageID: string) => Part[],
  ): { suggestion: TaskSuggestion.Suggestion; messageID: string; partID: string } | undefined => {
    for (const message of [...assistantMessages].reverse()) {
      const parts = getMessageParts(message.id)
      const text = parts.toReversed().find((part) => part.type === "text" && !!part.text?.trim())
      if (!text || text.type !== "text") continue
      const suggestion = TaskSuggestion.parse(text.text ?? "")
      if (suggestion) return { suggestion, messageID: message.id, partID: text.id }
    }
    return
  }
```

Edit 4 — `packages/app/src/pages/session/timeline/rows.ts`, hoist the suggestion computation above the `assistantItems.forEach` (it currently sits after it, next to the chip comment) and set the flag on the matching push. Replace the `AssistantPart` push inside the `forEach`:

```ts
      rows.push(
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
          verbose: viewMode === "verbose",
          hideTrailingSuggestion:
            found &&
            item.group.type === "part" &&
            item.group.ref.messageID === found.messageID &&
            item.group.ref.partID === found.partID
              ? true
              : undefined,
        }),
      )
```

And replace the chip block below the `forEach` to use the hoisted `found`:

```ts
    // Task chip: the model-suggested follow-up renders after the turn's parts
    // once the turn has settled (not while it is still streaming).
    const suggestion = found?.suggestion
    if (suggestion) {
      rows.push(
        new TimelineRow.TaskSuggestion({
          userMessageID: userMessage.id,
          title: suggestion.title,
          prompt: suggestion.prompt,
          note: suggestion.note,
        }),
      )
    }
```

with this hoisted above `let assistantGroupIndex = 0` (before the `forEach`):

```ts
    // Task chip: the model-suggested follow-up renders after the turn's parts
    // once the turn has settled (not while it is still streaming).
    const settled = !(isActive && status === "busy")
    const found = settled
      ? MessageComment.taskSuggestionFromMessages(assistantMessages, getMessageParts)
      : undefined
```

Delete the now-duplicate `settled`/`suggestion` lines that used to sit between the `forEach` and the chip push. The chip comment stays with the hoisted computation; keep a short comment at the push site: `// Chip row for the suggestion computed above.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test --isolate --conditions=solid --only-failures --preload ./happydom.ts ./src/pages/session/timeline/task-chips.test.ts ./src/pages/session/timeline/task-chip-source.test.ts`
Expected: PASS (all tests in both files, including the pre-existing chip tests).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/timeline/rows.ts packages/app/src/pages/session/timeline/timeline-row.ts packages/app/src/pages/session/timeline/task-chips.test.ts
git commit -m "feat(app): flag envelope-bearing assistant row in timeline"
```

---

### Task 3: Renderer strips the envelope on flagged rows

**Files:**
- Modify: `packages/app/src/pages/session/timeline/message-timeline.tsx` (import `TaskSuggestion`; stripped-copy logic in `renderAssistantPartGroup`)
- Test: `packages/app/src/pages/session/timeline/task-chip-source.test.ts` (source-contract test)

**Interfaces:**
- Consumes: `hideTrailingSuggestion?: boolean` from Task 2 (on both row shapes) and `TaskSuggestion.strip` from Task 1.
- Produces: settled assistant body text without the trailing envelope; copy-response copies prose without the XML tag (the copy action reads the rendered part). Produces nothing for later tasks.

- [ ] **Step 1: Write the failing test**

Append to the `describe("session task chip wiring", ...)` block in `packages/app/src/pages/session/timeline/task-chip-source.test.ts`:

```ts
  test("settled body text hides the envelope the chip represents", () => {
    expect(rowsSource).toContain("hideTrailingSuggestion")
    expect(timelineSource).toContain("hideTrailingSuggestion")
    expect(timelineSource).toContain("TaskSuggestion.strip")
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --isolate --conditions=solid --only-failures --preload ./happydom.ts ./src/pages/session/timeline/task-chip-source.test.ts`
Expected: FAIL on the new test (`hideTrailingSuggestion` absent from both sources); all existing tests pass.

- [ ] **Step 3: Write the minimal implementation**

Edit 1 — `packages/app/src/pages/session/timeline/message-timeline.tsx` line 87, extend the rows import:

```ts
import { MessageComment, SummaryDiff, TaskSuggestion, TimelineRow, TimelineRowMap } from "./rows"
```

Edit 2 — in `renderAssistantPartGroup`, replace the `part` memo (it currently looks up the part and returns it directly):

```ts
    const part = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return
      const item = getMsgPart(group.ref.messageID, group.ref.partID)
      if (!item) return
      // The chip row already represents the suggestion; strip the raw
      // envelope from settled body text so it does not render twice.
      if (row().hideTrailingSuggestion && item.type === "text" && item.text) {
        return { ...item, text: TaskSuggestion.strip(item.text) }
      }
      return item
    })
```

This is safe post-settle because the `part_text_accum_delta` entry is deleted on completion (`session-cache.ts`, `event-reducer.ts`), so the text renderer falls back to the stripped copy; streaming turns never carry the flag (no chip row is built while busy).

- [ ] **Step 4: Run the tests and typecheck to verify they pass**

Run: `bun test --isolate --conditions=solid --only-failures --preload ./happydom.ts ./src/pages/session/timeline/task-chips.test.ts ./src/pages/session/timeline/task-chip-source.test.ts`
Expected: PASS.

Run: `bun run typecheck`
Expected: clean (no errors).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/timeline/message-timeline.tsx packages/app/src/pages/session/timeline/task-chip-source.test.ts
git commit -m "feat(app): hide raw task-suggestion envelope in settled turns"
```

---

### Task 4: Toast when a chip has no worktree to start in

**Files:**
- Modify: `packages/app/src/pages/session/timeline/message-timeline.tsx` (`startTaskSession` no-root branch)
- Modify: `packages/app/src/i18n/en.ts` (two new keys after the `session.taskSuggestion.confirm.*` block)
- Modify: `packages/app/src/i18n/flynncode-fallback.ts` (two new keys in the `keys` array after `"session.taskSuggestion.confirm.title"`)
- Test: `packages/app/src/pages/session/timeline/task-chip-source.test.ts` (source-contract test)

**Interfaces:**
- Consumes: nothing from Tasks 1–3 (independent surface, same files).
- Produces: `session.taskSuggestion.noWorktree.title` = `Can't start a task here`, `session.taskSuggestion.noWorktree.description` = `Task chips need a git worktree. Open a project inside a git repository to start this in its own session.` Produces nothing for later tasks (last task).

- [ ] **Step 1: Write the failing test**

Append to the `describe("session task chip wiring", ...)` block in `packages/app/src/pages/session/timeline/task-chip-source.test.ts`:

```ts
  test("missing worktree shows a toast instead of failing silently", () => {
    expect(timelineSource).toContain("session.taskSuggestion.noWorktree.title")
    expect(timelineSource).toContain("session.taskSuggestion.noWorktree.description")
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --isolate --conditions=solid --only-failures --preload ./happydom.ts ./src/pages/session/timeline/task-chip-source.test.ts`
Expected: FAIL on the new test (keys not referenced yet); all existing tests pass.

- [ ] **Step 3: Write the minimal implementation**

Edit 1 — `packages/app/src/i18n/en.ts`, after the line `"session.taskSuggestion.confirm.action": "Start task",` insert:

```ts
  "session.taskSuggestion.noWorktree.title": "Can't start a task here",
  "session.taskSuggestion.noWorktree.description": "Task chips need a git worktree. Open a project inside a git repository to start this in its own session.",
```

Edit 2 — `packages/app/src/i18n/flynncode-fallback.ts`, in the `keys` array after the line `"session.taskSuggestion.confirm.title",` insert:

```ts
  "session.taskSuggestion.noWorktree.description",
  "session.taskSuggestion.noWorktree.title",
```

Edit 3 — `packages/app/src/pages/session/timeline/message-timeline.tsx`, in `startTaskSession`, replace the silent early return:

```ts
  const startTaskSession = async (prompt: string) => {
    const root = sync().project?.worktree
    if (!root) {
      showToast({
        title: language.t("session.taskSuggestion.noWorktree.title"),
        description: language.t("session.taskSuggestion.noWorktree.description"),
      })
      return
    }
```

(`showToast` and `language` are already imported in this file.)

- [ ] **Step 4: Run the tests, the i18n parity test, and typecheck**

Run: `bun test --isolate --conditions=solid --only-failures --preload ./happydom.ts ./src/pages/session/timeline/task-chips.test.ts ./src/pages/session/timeline/task-chip-source.test.ts`
Expected: PASS.

Run: `bun test --isolate --conditions=solid --only-failures --preload ./happydom.ts ./src/i18n/parity.test.ts`
Expected: PASS (new keys exist in both `en.ts` and the fallback module).

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/session/timeline/message-timeline.tsx packages/app/src/pages/session/timeline/task-chip-source.test.ts packages/app/src/i18n/en.ts packages/app/src/i18n/flynncode-fallback.ts
git commit -m "feat(app): toast when task chip has no worktree"
```
