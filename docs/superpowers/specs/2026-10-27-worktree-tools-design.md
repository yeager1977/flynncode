# Worktree Tools Design

Date: 2026-10-27
Status: implemented (commits badc5e19d7, 02fb99ac98, a22f72ae15, hardened in the final-review fixes); this document describes the shipped behaviour

## Problem

Flynncode's main agent cannot move its session into a git worktree mid-session. Sub-agents can already run in an isolated worktree (`task` with `isolation: "worktree"`), and the user can move a session's primary folder from the sidebar. Claude Code's agent has `EnterWorktree` and `ExitWorktree`.

This is part 3 of workstream 4 of the 2026-10-26 agent-parity plan:
1. Claude-compatible hooks (done)
2. Agent scheduling (done)
3. Worktree tools (this spec)
4. Status line

## Decisions

- **Entering asks every time.** `enter_worktree` uses a new `worktree` permission key, default `ask`. The prompt shows the branch and path, and offers no "always" approval.
- **Discarding has its own key.** A forced removal asks under `worktree_discard`, default `ask`. It is in `Permission.ALWAYS_ASK`, so no approval mode (allow, auto with an auto-reviewer allow, accept-edits) approves it silently, and a grant of `worktree` (for example a Claude command's `allowed-tools: EnterWorktree`) never covers it.
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
- **Order:** the ask comes before anything is written: a denied ask leaves no folder, no `info/exclude` entry and no branch. The tool then waits for the checkout (`createFromInfo(..., { awaitCheckout: true })`), because the next step works in the folder. The boot and start scripts still run in the background.
- **Switching:** it moves the session's primary folder to the worktree and records session metadata `worktree` (the existing binding) plus `enteredFrom: <previous primary folder>` and `disposable: true`. Writes are merge-safe and never clobber other metadata keys.
- **Result:** the worktree path and branch.
- **Permission:** key `worktree`, default `ask`. The prompt's patterns are the branch and path.

**`exit_worktree { action: "keep" | "remove", discard_changes?: boolean }`**
- **Scope:** only valid when the session's current worktree was entered with `enter_worktree` (`enteredFrom` is set). Otherwise it returns a clear error and changes nothing.
- **Switching back:** it moves the session's primary folder back to `enteredFrom`, clears `enteredFrom`, and clears the worktree binding.
- **`keep`:** leaves the worktree and branch in place. The worktree janitor's normal rules apply later.
- **`remove`:** deletes the worktree only when nothing would be lost, using the existing `disposeIfSafe` check (uncommitted changes, unpushed or unmerged commits). Otherwise it refuses, lists what would be lost, and the session stays in the worktree.
- **`discard_changes: true`:** forces removal, which also deletes the branch. It asks under the `worktree_discard` key, with the pattern `discard <path> (branch <b>): <loss>`.
- **Only a recorded, registered worktree is removed.** `remove` (with or without `discard_changes`) is refused, with nothing asked or deleted, when the session metadata has no `worktree` path, or when that path exists but is not a registered linked worktree of this project. `keep` still works then.
- **Prompts:** `keep` and safe `remove` need no permission prompt.
- **Removal while in use:** during a turn the worktree's instance is busy, so an in-turn `remove` is normally pending. The removal is recorded on the session (metadata `worktreeRemovals`, keyed by path) and done by the `WorktreeRemoval` service once nothing runs in the worktree. The record survives a restart: the service reads unfinished records when it starts and completes them. Right before deleting, every removal re-checks that the path is still a registered worktree of this project, and a forced removal re-runs the loss check: if anything would now be lost that the user did not approve, the worktree is kept and a warning is logged. When a pending removal finishes, the record is dropped and the tool call's metadata is updated to its final state (`removed: true|false`, no `pending`).

### Turn mechanics

- **After each tool step,** the prompt loop compares the session's primary folder with the folder the step ran in. If it changed, the loop:
  - finishes that step;
  - provides the instance for the new folder;
  - continues the same turn there.

  History is reloaded before continuing, as at every step.
- **The model is told** with a one-line note on the next request only: "Working directory is now `<path>` (branch `<branch>`)." (no branch part when detached or not git). It is an ephemeral trailing user message: it is not persisted, the tool output says the same, and the system environment names the new folder from the next request on. When the switching step also ends the turn (for example a rejected permission in the same step), the loop still moves the turn to the new folder, so the Stop hook, the idle status and the next turn are there, but no further request is made and the note is not sent.
- **One switch per step:** the step (its assistant message) is claimed in `SessionRunState` before anything can yield, so parallel `enter_worktree`/`exit_worktree` calls of one step cannot both switch; a failed switch releases the claim, and the claim ends with the turn.
- **Runner ownership:** the turn's runner stays in the instance where the turn started. Prompt, steer, queue and cancel sent through the new folder reach it; the session reads busy in the new folder and goes idle there.
- **What stays with the session:** extra folders, background shells, scheduled jobs, sticky hook context (SessionStart, SubagentStart, PostCompact `additionalContext`, now stored per session rather than per folder) and the "always" approvals this session gave. Running background shells keep their original working directory.
- **Approvals scope:** only the approvals the moving session gave, or had carried, move with it, in both directions, and in the new folder they answer that session's requests only. Approvals other sessions gave stay in their folder.
- **What follows the new folder:** snapshots and the session diff, from the next step on (the diff only compares steps of the same checkout). The Stop hook is looked up and run in the folder the turn ended in.
- **Sidebar primary switch while busy:** a primary switch that reloads the new primary's instance (the folders route) is refused while the session runs a turn (`SessionFolderBusyError`, answered as a 400 `InvalidRequestError` on `primary`), because the reload would interrupt the turn or leave it on a disposed instance. Refusing was chosen over deferring the reload: it never interrupts work and needs no queued state. The tools' own switches do not reload and are unaffected.

### App

- The session moves to the worktree's group in the sidebar, using the existing grouping by directory.
- If the session is open, the app follows it to its new folder and stays on the conversation, with streaming continuing and no reload.
- Each switch shows as a compact divider in the transcript:
  - "⎇ Entered worktree `<branch>`"
  - "⎇ Back in `<folder>` (worktree kept)", "(worktree removed)" or, while a removal waits, "(removal pending)"

  The divider is the tool call's own card (`enter_worktree`/`exit_worktree` renderers in session-ui), not a turn divider, because the switch happens mid-turn. Its text comes from the tool part's metadata `worktree: { action: "enter", branch?, path }` or `{ action: "exit", path, from, removed, pending? }`, where `path` is the folder now in. A failed or refused call keeps the ordinary card. A pending removal's card changes to kept or removed once the removal finishes.
- The new-layout route (`/server/:key/session/:id`) derives the directory from the session and follows on its own; the classic route (`/:dir/session/:id`) navigates to the new folder with `replace`, keeping the server-wide session store and its stream.

### Lifetime

- A worktree entered this way is marked disposable. Archiving or deleting the session disposes it only when nothing would be lost, through the existing disposal path for disposable worktrees.
- Otherwise, the worktree janitor's idle rules apply.

### Claude compatibility

- Claude Code's `EnterWorktree` and `ExitWorktree` names map to these tools for hook matchers (`hooks/claude-format.ts` `NAMES`). In `TOOLS` (config/claude.ts), whose values are permission keys, both map to `worktree`, so Claude agent `tools:` lists and `allowed-tools` grant entering and leaving. Neither grants `worktree_discard` (a built-in permission), so a Claude agent allowlist denies discarding and a Claude command grant still asks.
- Claude's `WorktreeCreate` and `WorktreeRemove` hook events and its `--worktree` CLI flag are out of scope.

## Error handling

- **Creation fails** (a git error, the branch already exists, or the checkout fails, for example a failing smudge filter): the tool returns the message and the session stays put. A worktree that was added but not checked out is removed again, with its branch. Callers that do not await the checkout keep the old behaviour: they get the worktree and a `worktree.failed` event.
- **The folder switch fails after creation:** the new worktree is removed again and the session stays put.
- **`enteredFrom` no longer exists:** `exit_worktree` moves the session to the project's main folder and says so.
- **Removal is unsafe:** the tool lists what would be lost and changes nothing.
- **The worktree path is not recorded, or is not a registered worktree:** `remove` is refused and nothing is deleted.
- **A pending forced removal would now lose more than was approved:** the worktree is kept and a warning logged.

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
9. **Hardening:** sticky SessionStart context reaches every request after a switch and back; a failing checkout fails `enter_worktree` and removes the worktree; `worktree_discard` prompts in every approval mode and under a Claude worktree grant; carried approvals stay with the moving session; a missing or unregistered worktree path refuses removal; a deferred discard keeps the worktree when the loss grew; a recorded removal is completed by a freshly started service; a pending removal's tool card shows the final state; a reloading primary switch is refused during a turn; a step that switches and ends the turn goes idle in the new folder; creating twice writes the `info/exclude` entry once.

## Out of scope

- Claude's `WorktreeCreate` and `WorktreeRemove` hooks.
- A `--worktree` CLI flag.
- The status line (own spec).
