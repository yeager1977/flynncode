# Agent Memories

Opt-in (default-off) on-disk memories, modeled on `~/.codex/memories`.
Plain markdown files, local only, never synced.

## Enable

In `opencode.json`:

```json
{
  "memory": { "enabled": true }
}
```

Tunables (defaults shown): `min_turns: 4`, `max_files: 20`,
`max_chars_per_file: 4000`.

## Locations

- Global: `<XDG data>/opencode/memories/*.md` (outside any repo).
- Project: `<worktree>/.opencode/memories/*.md` (committable, like
  `AGENTS.md` — commit conventions, not secrets).

## Behavior

- Memories load into the system prompt as `Memory from: <path>` lines,
  after `MEMORY.md` entries.
- At session end, sessions with fewer user turns than `min_turns` are
  skipped; longer sessions run one small-model extraction turn whose
  result is redacted and appended to the project memory dir.
- All reads and writes pass secret redaction (github, openai, aws-key,
  slack, private-key, bearer, url-credentials, generic assignments).

## Never synced

Share upload (`share-next`) syncs session/message/part/diff/model rows
only — the system prompt (where memories ride) is never part of the
payload, and memory files are never read by share code. Global memories
live outside repos by construction; project memories are only shared if
you commit them yourself.
