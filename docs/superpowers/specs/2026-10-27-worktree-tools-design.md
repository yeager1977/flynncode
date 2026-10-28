# Worktree Tools Design

Date: 2026-10-27
Status: approved design, pending implementation plan

## Problem

Flynncode's main agent cannot move its session into a git worktree mid-session. Sub-agents can already run in an isolated worktree (`task` with `isolation: "worktree"`), and the user can move a session's primary folder from the sidebar. Claude Code's agent has `EnterWorktree` and `ExitWorktree`.

This is part 3 of workstream 4 of the 2026-10-26 agent-parity plan:
1. Claude-compatible hooks (done)
2. Agent scheduling (done)
3. Worktree tools (this spec)
4. Status line

## Decisions

- **Entering asks every time.** `enter_worktree` uses a new `worktree` permission key, default `ask`. The prompt shows the branch and path.
- **Move the session itself.** The tool switches the session's primary folder, the same mechanism as the folders route's primary switch. The prompt loop then continues the turn under the new folder. Rejected alternatives:
  - per-call cwd overrides, which would break path checks, LSP and the sandbox;
  - a hand-off to a child session.

## Design

### Tools

**`enter_worktree { name?: string }`**
- **Refused when:**
  - the project is not a git repository;
  - the session is a sub-agent's (it has a parent);
  - the session is already inside a worktree it entered with `enter_worktree`;
  - another folder switch already happened in this step.
- **Creating the worktree:** it uses the existing worktree service (`packages/flynncode/src/worktree`), with its configured `location`, `branch_prefix`, `.worktreeinclude` and start scripts. The branch is `<branch_prefix>/<name>` when `name` is given, else `<branch_prefix>/session-<slug>`.
- **Switching:** it moves the session's primary folder to the worktree and records session metadata `worktree` (the existing binding) plus `enteredFrom: <previous primary folder>` and `disposable: true`. Writes are merge-safe and never clobber other metadata keys.
- **Result:** the worktree path and branch.
- **Permission:** key `worktree`, default `ask`. The prompt's patterns are the branch and path.

**`exit_worktree { action: "keep" | "remove", discard_changes?: boolean }`**
- **Scope:** only valid when the session's current worktree was entered with `enter_worktree` (`enteredFrom` is set). Otherwise it returns a clear error and changes nothing.
- **Switching back:** it moves the session's primary folder back to `enteredFrom`, clears `enteredFrom`, and clears the worktree binding.
- **`keep`:** leaves the worktree and branch in place. The worktree janitor's normal rules apply later.
- **`remove`:** deletes the worktree only when nothing would be lost, using the existing `disposeIfSafe` check (uncommitted changes, unpushed or unmerged commits). Otherwise it refuses, lists what would be lost, and the session stays in the worktree.
- **`discard_changes: true`:** forces removal. It asks under the `worktree` key, with a pattern describing the loss.
- **Prompts:** `keep` and safe `remove` need no permission prompt.

### Turn mechanics

- **After each tool step,** the prompt loop compares the session's primary folder with the folder the step ran in. If it changed, the loop:
  - finishes that step;
  - provides the instance for the new folder;
  - continues the same turn there.

  History is reloaded before continuing, as at every step.
- **The model is told** with a one-line synthetic note on the next step: "Working directory is now `<path>` (branch `<branch>`)."
- **What stays with the session:** extra folders, background shells, scheduled jobs and permission approvals. Running background shells keep their original working directory.
- **What follows the new folder:** snapshots and the session diff, from the next step on.

### App

- The session moves to the worktree's group in the sidebar, using the existing grouping by directory.
- If the session is open, the app follows it to its new folder and stays on the conversation, with streaming continuing and no reload.
- Each switch shows as a compact divider in the transcript:
  - "⎇ Entered worktree `<branch>`"
  - "⎇ Back in `<folder>` (worktree kept)" or "(worktree removed)"

  The text comes from the tool part, or from synthetic part metadata `worktree: { action, branch?, path }`.

### Lifetime

- A worktree entered this way is marked disposable. Archiving or deleting the session disposes it only when nothing would be lost, through the existing disposal path for disposable worktrees.
- Otherwise, the worktree janitor's idle rules apply.

### Claude compatibility

- Claude Code's `EnterWorktree` and `ExitWorktree` names map to these tools in the compat pack's tool map. Claude agent `tools:` lists and Claude-format hook matchers therefore work.
- Claude's `WorktreeCreate` and `WorktreeRemove` hook events and its `--worktree` CLI flag are out of scope.

## Error handling

- **Creation fails** (a git error, or the branch already exists): the tool returns the message and the session stays put.
- **The folder switch fails after creation:** the new worktree is removed again and the session stays put.
- **`enteredFrom` no longer exists:** `exit_worktree` moves the session to the project's main folder and says so.
- **Removal is unsafe:** the tool lists what would be lost and changes nothing.

## Testing

All tests use real git repositories, the real worktree service and the test LLM server, with no mocks.

1. **Enter:** creates the worktree. The next tool call in the same turn runs there; for example, bash `pwd` prints the worktree path.
2. **Exit keep:** returns to the original folder and leaves the worktree.
3. **Exit remove:**
   - with no changes, deletes the worktree;
   - with uncommitted changes, refuses and lists them;
   - with `discard_changes`, asks and then removes.
4. **Refusals:** a non-git project, a sub-agent session, entering twice, and exiting a worktree not entered by the tool.
5. **Permission:** entering asks under `worktree`, with the branch and path.
6. **Archive:** archiving a session inside an entered worktree disposes it only if safe.
7. **Metadata:** other keys survive enter and exit.
8. **App:** the follow-the-session helper and the divider text (browser suite).

## Out of scope

- Claude's `WorktreeCreate` and `WorktreeRemove` hooks.
- A `--worktree` CLI flag.
- The status line (own spec).
