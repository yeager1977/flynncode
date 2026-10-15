# Task-chip parity: hide raw envelope, toast when no worktree

Date: 2026-10-15
Status: approved in chat

## Problem

Task chips (Lane E item 2, `37a8724c2b` + `4b806075c6`) work end to end — model
guidance, envelope parse, chip render, click starts a worktree session — but two
gaps remain versus Claude's "little cards":

1. **Raw envelope leaks into the message body.** The chip row is appended, but
   the `<task-suggestion …>…</task-suggestion>` line stays in the assistant text
   part and renders (raw or as a stray duplicate of the note) next to the card.
   Claude shows only the card.
2. **Silent no-op outside worktrees.** `startTaskSession` returns without
   feedback when the project has no worktree root (non-git directory), so a chip
   click appears to do nothing.

## Verified working (no changes)

- Guidance: `message.txt` + `session-manage.txt` tool descriptions; both tools
  always in the desktop toolset (`packages/flynncode/src/tool/registry.ts`).
- Parse: `TaskSuggestion.parse` in
  `packages/app/src/pages/session/timeline/rows.ts` (entities, escapes, rejects
  partial envelopes, ignores tool output, last-text-part only).
- Chip row: suppressed while streaming, appended once settled
  (`constructSessionMessageRows`); `data-action="session-task-suggestion"`.
- Click flow: confirm dialog → `worktree.create` → pending state → new draft
  session with the prompt (new layout), or handoff + `?prompt=` (legacy).
- Tests green: 12 app (`task-chips`, `task-chip-source`) + 8 core
  (`session-manage` envelope parse).

## Design

### A. Strip the trailing envelope from settled body text

Render-layer only. The durable transcript is untouched, `session-ui` is
untouched, and the `MessagePart` API is unchanged.

- `rows.ts`, `TaskSuggestion` namespace, new pure helper `strip(text)`:
  removes one trailing `<task-suggestion …>…</task-suggestion>` block plus
  preceding blank-line whitespace; returns the input unchanged when the
  envelope is absent or not trailing. Browser-safe, unit-testable.
- `timeline-row.ts`: the `AssistantPart` row (map type + class) gains optional
  `hideTrailingSuggestion?: boolean`.
- `constructSessionMessageRows`: after computing `suggestion` for a settled
  turn, locate the source text part with the same scan order as
  `taskSuggestionFromMessages` (reversed assistant messages, last text part)
  and set the flag on the `AssistantPart` row whose `group.type === "part"`
  and `group.ref` matches `{ messageID, partID }`. If no row matches
  (defensive), no flag is set and nothing is stripped.
- `message-timeline.tsx` `renderAssistantPartGroup`: when the flag is set and
  the looked-up part is text, pass a shallow copy with
  `text: TaskSuggestion.strip(part.text)` into `MessagePart`. Post-settle the
  `part_text_accum_delta` entry is deleted (`session-cache.ts`,
  `event-reducer.ts`), so `readPartText` falls back to the stripped copy; the
  copy-response action then copies prose without the XML tag.
- Streaming turns are unchanged: the envelope stays visible while typing, and
  no chip renders until the turn settles (current behavior).

### B. Toast when the project has no worktree

- `startTaskSession` in `message-timeline.tsx`: when
  `sync().project?.worktree` is falsy, call `showToast` and return, mirroring
  the existing `prompt.toast.worktreeCreateFailed` pattern:
  - `session.taskSuggestion.noWorktree.title`: `Can't start a task here`
  - `session.taskSuggestion.noWorktree.description`: `Task chips need a git worktree. Open a project inside a git repository to start this in its own session.`
- Keys go in `packages/app/src/i18n/en.ts` plus the matching fallback module
  (same pattern as the existing `session.taskSuggestion.confirm.*` keys).

## Tests (from package dirs)

- `task-chips.test.ts`: `strip` matrix (trailing envelope removed, preceding
  prose kept, mid-text envelope untouched, no-envelope passthrough); row test:
  settled turn with envelope → final text `AssistantPart` row flagged + chip
  row still emitted; streaming turn → no flag, no chip.
- `task-chip-source.test.ts`: source-contract assertions that the renderer
  applies the strip only when the flag is set, and that the no-worktree branch
  shows a toast.
- `bun typecheck` in `packages/app`; i18n parity test must pass.

## Out of scope

No transcript mutation, no `session-ui` changes, no prompt-guidance or gating
changes, no cloud/web surfaces.
