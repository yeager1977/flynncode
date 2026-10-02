# Flynncode supervision loop and local reach

Date: 2026-09-30
Status: Draft — awaiting review
Product: Flynncode desktop, not upstream OpenCode

## Decision

Build the Codex supervision loop on surfaces Flynncode already has, then add the two Claude local-reach pieces that are missing: a browser pane beside review, and a global quick-entry composer. Do not add a vendor sign-in, a public cloud, computer use, voice, or a hosted site. Deepthought stays out of this spec.

Usability cleanup is in scope only where it blocks that loop: task rows that will not collapse, a tasks pane that shares the file window, and review comments that do not become the next turn.

## What already exists

- Review pane with line comments (`addCommentToContext` in `packages/app/src/pages/session.tsx`).
- Git worktree create, list, remove, and reset (`packages/opencode/src/worktree/index.ts`). New-session can create a worktree. There is no per-session disposable retention and no checkout handoff. `packages/app/src/pages/session/handoff.ts` moves prompts and selected lines between UI surfaces. It does not move a branch.
- PTY terminal, file tree, permission docks (`once`, `always`, `reject`), todo dock, subagent list, timeline, composer.
- Routines (`dailyAt` only), dispatch (cap 40), artifacts sidebar, unfocused-window notifications.
- Desktop deep links (`opencode://`) already reach the main process.
- Ollama model router. Local inference stays the point. No ChatGPT or Claude account is required for this work.

## Slice 1 — Supervision loop

### Disposable session worktree

A session may run in the primary checkout or in a worktree created through the existing `Worktree` service. A session worktree is disposable: Flynncode keeps the 15 most recent, and does not delete one tied to the open session or a session that is still running. Non-git directories cannot create a worktree. The UI says so and stays on the primary checkout.

### Checkout handoff

Handoff moves the session between the primary checkout and its worktree. It does not invent a second worktree API. Git still allows a branch in only one worktree. Ignored files move only when a `.worktreeinclude` file lists them. Handoff is explicit. It is not the prompt handoff in `handoff.ts`.

### Review return path

The existing review pane gains three scopes: last turn, unstaged, and branch. Line comments already enter composer context. The missing action is one follow-up, labeled from an i18n key, that means "address these comments." The model receives the comment locations and the selected scope. It does not receive a new review product.

Hunk stage, unstage, and revert apply to the Git diff in the selected scope. Message-level revert stays the existing revert dock. A Git hunk revert must not pretend to undo a chat message.

### Activity inbox

Running, needs input, and blocked are states on the existing dispatch list and the existing notification path. Routine runs land there too. Do not add a fourth list. A running child in the existing subagent list can be stopped or steered. Do not add a new subagent pane.

## Slice 2 — Local reach

### Browser beside review

A browser pane opens beside the existing review pane for a local dev server the session started. It uses a separate profile. Banking, email, and SSO cookies stay off. The user can click an element or drag a region, add a comment, and send that comment into the same review follow-up as a line comment. Prefer this pane over any later computer-use tool. Do not seize the desktop pointer.

### Quick entry

A global shortcut opens a small composer on top of other apps. Submit uses the existing `opencode://` deep-link path. It does not create a second session protocol. The shortcut is Linux-first (X11 and the Wayland GlobalShortcuts portal). macOS and Windows can follow the same IPC. Do not rebuild deep links.

## Usability cleanup

These are part of slice 1 because the loop is unusable without them.

- A task row in the right-hand tasks list shows the title in strong text. Click expands the output in a scrollable region. Click again collapses it. `expandSubagent` toggles when the same id is already expanded.
- The Tasks control stays where it is. Selecting Tasks hides the file and changes pane. If Tasks is the only right-hand pane, that pane fills the side. Switching back to a file tab restores the file pane.
- The todo dock keeps the prompt visible and puts verbatim detail in a scrollable expand. That work may already be dirty in the working tree. Finish it. Do not start a third dock.

## Out of scope

- Deepthought, phone push, and routines that run while the laptop sleeps.
- Computer use, voice, Sites, screen-history memory, vendor import.
- A skills settings page, a public share host, a multi-user review room.
- A new worktree HTTP API, a new scheduler, or a third session layout.
- Changing `noReply` scheduling or the Ollama router.

## Errors

- Non-git handoff or worktree create fails with the existing `WorktreeNotGitError` and leaves the session on the primary checkout.
- Handoff fails closed if the branch is already checked out elsewhere. The session stays where it is.
- Browser pane failure does not fail the session. Review and the diff remain usable.
- Quick entry with no running desktop focuses or launches the existing app, then delivers the prompt. It does not start a second server if one is already bound.

## Tests

- `expandSubagent` collapses when the same id is clicked again.
- Worktree retention keeps the open session and any running session, and drops the oldest idle worktree past 15.
- A review follow-up includes the selected scope and the comment locations, and does not call message revert.
- Tasks selected hides the file pane. Tasks as the only right pane uses the full side width.
- Quick entry submits through the existing deep-link handler.

## Build order

1. Toggle, tasks pane separation, and todo-dock scroll. These are the usability blockers.
2. Review scopes, comment follow-up, hunk revert.
3. Disposable worktree retention and checkout handoff.
4. Activity states on dispatch and notifications.
5. Browser pane and annotations.
6. Quick entry on the deep-link path.
