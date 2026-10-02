# Hunk stage and unstage

Date: 2026-09-30
Status: Draft — awaiting review
Product: Flynncode desktop, not upstream OpenCode

## Decision

Stage and unstage a hunk through the existing `vcs.apply` endpoint. Do not add a second VCS route. Revert stays a reversed working-tree patch and does not call message revert.

## What already exists

- `POST /vcs/apply` takes `{ patch }` and runs `git apply -` (`packages/opencode/src/project/vcs.ts`, `packages/opencode/src/git/index.ts`).
- The review pane already reverses a file patch and applies it for "Revert hunk" (`packages/app/src/pages/session/hunk-revert.ts`, `packages/app/src/pages/session/v2/review-panel-v2.tsx`).
- Review scopes are last turn, unstaged (`git`), and branch. Message revert stays on the revert dock.

## Apply mode

`ApplyInput` gains an optional `index` field:

- omitted or `worktree`: `git apply -`
- `stage`: `git apply --cached -`
- `unstage`: `git apply --cached -R -`

Old clients that send only `patch` keep working-tree apply. After the public HttpApi change, regenerate the client SDK. Do not edit generated files by hand.

## Review actions

Stage and unstage appear only when the selected scope is the unstaged git diff and the active file has a patch. Branch and last-turn diffs do not show them.

Revert stays available whenever a patch is present. It sends `reversePatch(patch)` with `index` omitted. It does not call the session revert API.

Button labels use i18n keys. Do not invent translations. English source may be the fallback where no corpus phrase exists.

## Errors

- Non-git fails with the existing `PatchApplyError` reason `non-git`. The checkout does not change.
- A patch that does not apply fails with reason `not-clean`. The index and working tree stay as they were. The UI shows the existing patch-failed toast.
- Failure does not revert a chat message.

## Tests

- Mode mapping: omitted and `worktree` are plain apply, `stage` is cached apply, `unstage` is cached reverse apply.
- Stage and unstage controls are absent for branch and last-turn scopes.
- A failed apply does not call message revert.

## Out of scope

- A new `/vcs/hunk` route.
- Staging a branch diff or a last-turn snapshot.
- Artifact preview and project memory. Those are later specs.
- Changing message revert, `noReply`, or the Ollama router.
