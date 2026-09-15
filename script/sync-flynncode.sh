#!/usr/bin/env bash
# Nightly sync of yeager1977/flynncode dev with anomalyco/opencode dev.
#
# Run from a systemd user timer (flynncode-sync.timer). Brings the fork's dev
# up to date with upstream dev and pushes to origin. Never force-pushes,
# never resolves conflicts, never touches uncommitted work.

set -euo pipefail

REPO="${FLYNNCODE_REPO:-$HOME/GitHub/flynncode}"
BRANCH="${FLYNNCODE_BRANCH:-dev}"
REMOTE="${FLYNNCODE_REMOTE:-upstream}"
TARGET_REMOTE="${FLYNNCODE_TARGET_REMOTE:-origin}"
MERGE_LOG="${FLYNNCODE_MERGE_LOG:-/tmp/flynncode-sync-merge.log}"
LOCK_FILE="${FLYNNCODE_LOCK:-/tmp/flynncode-sync.lock}"

log() {
  printf '%s %s\n' "$(date -Is)" "$*"
}

notify() {
  local urgency="$1" title="$2" body="$3"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send -u "$urgency" "$title" "$body" >/dev/null 2>&1 || true
  fi
}

fail() {
  log "ERROR: $*"
  notify critical "flynncode sync failed" "$*"
  exit 1
}

is_ancestor() {
  git merge-base --is-ancestor "$1" "$2"
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Another sync is already running; exiting"
  exit 0
fi

[ -d "$REPO/.git" ] || fail "repo not found at $REPO"

cd "$REPO"

if [ -n "${FLYNNCODE_WORK_DIR:-}" ]; then
  WORK_DIR="$FLYNNCODE_WORK_DIR"
  WORKTREE=""
  CLEANUP_WORKTREE=""
else
  CURRENT_BRANCH="$(git branch --show-current)"

  if [ "$CURRENT_BRANCH" = "$BRANCH" ]; then
    [ -n "$(git status --porcelain)" ] && fail "uncommitted changes in $REPO; skipping sync"
    WORK_DIR="$REPO"
    WORKTREE="$REPO"
  else
    OTHER_WORKTREE="$(
      git worktree list --porcelain |
        awk -v want="refs/heads/$BRANCH" '
          /^worktree / { wt = $2 }
          /^branch / { if ($2 == want) print wt }
        '
    )"
    [ -n "$OTHER_WORKTREE" ] &&
      fail "$BRANCH is checked out at $OTHER_WORKTREE; refusing to move it behind its back"

    WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/flynncode-sync.XXXXXX")"
    git worktree add --detach "$WORKTREE" "$BRANCH" >/dev/null 2>&1 ||
      fail "could not create temporary worktree at $WORKTREE"
    WORK_DIR="$WORKTREE"
    CLEANUP_WORKTREE="$WORKTREE"
  fi
fi

cleanup() {
  if [ -n "${CLEANUP_WORKTREE:-}" ]; then
    git worktree remove --force "$CLEANUP_WORKTREE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log "Fetching $TARGET_REMOTE and $REMOTE"
git fetch --prune "$TARGET_REMOTE" || fail "fetch from $TARGET_REMOTE failed"
git fetch --prune "$REMOTE" || fail "fetch from $REMOTE failed"

START_HEAD="$(git rev-parse "$BRANCH")"

sync_one() {
  local source="$1"
  is_ancestor "$source" "$BRANCH" && return 0
  if is_ancestor "$BRANCH" "$source"; then
    log "Fast-forwarding $BRANCH to $source"
    git -C "$WORK_DIR" merge --ff-only "$source" >"$MERGE_LOG" 2>&1 ||
      fail "fast-forward to $source failed. See $MERGE_LOG"
  else
    log "Merging $source into $BRANCH"
    git -C "$WORK_DIR" merge --no-edit "$source" >"$MERGE_LOG" 2>&1 || return 1
  fi
  return 0
}

for source in "$TARGET_REMOTE/$BRANCH" "$REMOTE/$BRANCH"; do
  if ! sync_one "$source"; then
    git -C "$WORK_DIR" merge --abort >/dev/null 2>&1 || true
    CONFLICTS="$(grep -E '^CONFLICT' "$MERGE_LOG" | head -5 || true)"
    fail "merge conflict with $source; run aborted. $CONFLICTS"
  fi
done

if [ "$WORK_DIR" != "$REPO" ]; then
  NEW_HEAD="$(git -C "$WORK_DIR" rev-parse HEAD)"
  git update-ref "refs/heads/$BRANCH" "$NEW_HEAD" "$START_HEAD" ||
    fail "could not update refs/heads/$BRANCH"
fi

if [ "$(git rev-parse "$BRANCH")" = "$(git rev-parse "$TARGET_REMOTE/$BRANCH")" ]; then
  log "$TARGET_REMOTE/$BRANCH already up to date; nothing to push"
  exit 0
fi

log "Pushing $BRANCH to $TARGET_REMOTE"
git push "$TARGET_REMOTE" "$BRANCH" || fail "push to $TARGET_REMOTE/$BRANCH failed"

log "Synced $REMOTE/$BRANCH into $TARGET_REMOTE/$BRANCH ($START_HEAD -> $(git rev-parse --short "$BRANCH"))"
notify normal "flynncode sync complete" "Updated $BRANCH from $REMOTE/$BRANCH"
