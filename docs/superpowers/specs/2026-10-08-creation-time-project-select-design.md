# Creation-time project select — design

Date: 2026-10-08
Status: approved in chat, pending spec review

## Problem

On a new session, the composer project button looks like a switcher and is not one.
It opens a read-only popover. A second selector sits under the wordmark. People click
the composer button and cannot change the project the session will be created in.

## Goal

On the new-session composer only, that button chooses the project for the draft.
Picking an opened project, or opening a folder, sets the draft directory before send.
If no project is open, the same button says "New project" and opens the folder picker.

## Non-goals

- No project change on an existing session. That composer button stays the read-only
  popover from `2026-10-04-composer-project-indicator-design.md`.
- No session rebind, fork, or projectID change.
- No new server route.
- No File > Open Project fix in the new layout.
- No rename, avatar edit, or session-count popover on the new-session button.

## Approach

Reuse the existing draft project menu. Do not add a second picker.

`PromptInputV2Composer` gains an optional `projectControl` override. When set, that
element replaces the read-only `PromptInputV2ProjectControl`. Session pages omit it
and keep today's popover.

`NewSessionView` passes `PromptProjectSelector` into that slot. The selector already
lists opened projects, searches them, and has Add project, which opens the directory
picker. `createPromptProjectControls` already writes the choice onto the draft with
`tabs.updateDraft`. `DraftRoute` already provides `SDKProvider` from `draft.directory`,
and submit already creates the session in `sdk().directory`. No new write path.

The duplicate selector and "New project" button under the wordmark are removed.
The worktree row, git status, disposable note, and extra-folders row stay, and they
still render only after a project is selected.

### Empty list

If `controller.empty()` is true, the composer button uses the existing
`session.new.project.new` label ("New project") and calls `controller.add()`, which
opens the folder picker. It does not open an empty menu. `project.select`
(Mod+Shift+O) stays disabled while the list is empty, as it is today.

### Project change resets draft workspace state

Selecting a different project or folder must reset the new-session worktree selection
and extra folders before the draft directory changes. Otherwise a worktree path or
extra folder from the previous project can be submitted with the new one.
`createNewSessionWorkspaceController` already exposes `selection.reset` and
`folders.reset`. Call both from the draft select path when the chosen directory
differs from the current draft directory. Picking the already-selected project is a
no-op and does not reset.

### Trigger

The trigger rendered in the composer slot uses the current composer control metrics:
height 28, truncated name, avatar, chevron, max width 220px. Menu placement is
`top-start`, matching the other composer menus. Use the existing i18n keys
(`session.new.project.new`, `session.new.project.add`, `session.new.project.search`).
Do not add strings.

### RTL

Reuse the existing menu. Do not add physical `left`/`right` layout. Unknown project
names stay `dir="auto"`. Paths, if shown, stay LTR.

## Data flow

1. New session opens with the draft directory from the tab.
2. The composer button shows the opened project whose worktree or sandbox matches
   the draft directory. If the list is empty, it shows "New project". If the draft
   directory matches none of the opened projects, it shows that directory's basename
   and still opens the menu. It must not label a different project as selected.
3. Choosing a project or folder resets worktree and extra folders, then
   `tabs.updateDraft` sets `directory` (and server, when more than one server is
   connected).
4. `DraftRoute` re-provides the SDK for that directory.
5. Submit creates the session in `sdk().directory`.

Canceling the folder picker changes nothing.

## Error handling

Keep the current picker and `selectProject` failures. If the target server connection
is missing, selection returns without changing the draft. Do not add a new toast.

## Testing

- Session composer source still renders the read-only indicator and does not require
  the override.
- New-session view passes the selector into the composer slot and no longer renders
  `PromptProjectSelector` or `PromptProjectAddButton` under the wordmark.
- Choosing a different project resets worktree selection and extra folders, then
  updates the draft directory.
- Choosing the current project does not reset.
- An empty project list invokes add (folder picker) instead of opening the menu.

## Out of scope follow-up

Making File > Open Project work in the new layout is separate. Do not do it here.
