# Subagent list

Date: 2026-09-24
Status: Approved approach, pending spec review

## Problem

Child sessions spawned by the task tool are not visible while the main chat stays open. The user has to leave the current session to see what a subagent is doing.

## Goal

This chat's child subagents appear as one collapsible list in two places: the right side panel, like files, and the terminal dock. A collapsed row shows status and a one-line preview. Expanding a row shows that child's messages in place. The main chat does not navigate.

## Scope

In scope:

- Only sessions whose `parentID` is the current session, plus task-tool parts on the current session that already name a child `sessionId`. A background task tool returns as soon as the child starts, so the row must appear then. Do not wait for the completion notice. A later `<task state="completed">` or `<task state="error">` moves that child to the finished group.
- One shared list component, mounted in the right side panel and in the terminal dock.
- One shared expanded child id. Expanding a row in either place expands that same row in the other place.
- One expanded child at a time. Expanding a second child collapses the first.
- Collapsed row: child title, status, and a one-line preview of its latest message text.
- Expanded row: that child's messages, read-only, with no second composer and no second permission dock.
- Active children stay in the top group. Finished children move into a collapsed group below the active ones.
- The finished group is collapsed by default. Opening it does not expand a child. Expanding a finished child from either mount opens the finished group in both mounts so the expanded row is visible.
- The list is hidden when this session has no children. If every child is finished, the list still shows, with only the collapsed finished group.
- A child that is still loading shows its row. Messages appear when they arrive.
- A deleted child disappears from both mounts.
- New user-visible English strings use i18n keys. Child titles and message text use `dir="auto"`. Panel layout uses logical properties. No new physical left/right layout.

Out of scope:

- Opening the child as the main chat.
- Agents this session messaged that are not child sessions.
- Every running agent in the workspace.
- A second permission or question dock. Existing parent prompts stay where they are.
- Replacing the terminal. The dock keeps the terminal and adds the list beside it.

## Status groups

Session status is `busy`, `retry`, or `idle`.

- Active: status is `busy` or `retry`.
- Finished: status is `idle`.

`retry` stays with the active group because the child is still working. Idle children move to the finished group. Do not add an error badge. Idle is finished, whether the last turn succeeded or failed.

Order inside each group is most recently updated first.

## Architecture

- A pure helper groups the current session's children into active and finished, builds the one-line preview, and resolves the shared expanded id.
- `packages/app` session view state owns the expanded child id and whether the finished group is open. Both mounts read and write that state.
- The right side panel gains a Tasks tab beside the existing file browser tab. It uses the same panel width and chrome.
- The terminal dock gains a Tasks section in the existing dock chrome. It does not replace the terminal. Collapsing the Tasks section does not close the terminal. Collapsing the terminal does not clear the expanded child.
- The expanded body reuses the existing message projection for that child session. It does not mount the session composer.

## Data flow

1. The session page reads sessions whose `parentID` equals the open session id, plus each child's status.
2. The helper splits them into active and finished and builds each preview from the latest text in that child. If there is no text yet, the preview is empty.
3. Both mounts render the same helper output.
4. Expanding a row writes the shared expanded id. Expanding a finished child also opens the finished group.
5. The expanded body renders that child's messages. The main session route does not change.

## Error handling

- A missing child status is treated as `idle`, so the row is finished rather than hidden.
- A child with no loaded messages shows the row and an empty expanded body, not an error.
- Deleting a child clears the expanded id when it was the expanded child.

## Testing

Pin the contracts in source tests. Solid render with `--conditions=solid` throws before component bodies, so do not depend on rendering the panel.

- Grouping: a `busy` or `retry` child is active. An `idle` child is finished. Missing status is finished.
- Order: most recently updated first inside each group.
- Preview: one line, taken from the latest text. Empty when the child has no text.
- Expand: one id. Expanding a second id replaces the first. Expanding a finished id also opens the finished group.
- Both mounts read the same expanded id. This is a state test, not a second component test.
- The helper does not change the current session route.

## RTL

Child titles and message text stay `dir="auto"`. New panel chrome uses logical properties and the existing side panel and terminal dock. No new physical left/right layout.
