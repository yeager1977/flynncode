# Codex/Claude Parity Build-Out — Design

**Date:** 2026-10-09
**Status:** Approved (approach B — phased sub-projects, one branch)
**Source research:** `reports/Claude Codex gaps for Flynncode.md` (prior-session deliverable, committed to this branch) plus the current-session gap survey of the Flynncode tree against the October 2026 Claude Code and Codex feature sets.

## Goal

Implement the full 16-item prioritized build list from the research report, so Flynncode matches Codex and Claude Code on all supervision-loop and local-reach traits that fit the local-first constraint — while deliberately refusing the vendor-trait items the report explicitly skipped (cloud sessions, voice, Sites, Cowork fusion, Computer History, Gmail/Slack webhooks).

The one advantage the build protects: Ollama-backed local-model turns through the model router, with inference and workspace on user-controlled machines (desktop here; long-running/awake work targeted at the user's own host, referenced in this design as "deepthought" at `192.168.4.251`), never a vendor cloud.

## Execution structure

- **Branch:** `codex-parity-build`, branched from `dev`. All 16 items land here.
- **Four sequential phases** (below). Within a phase, independent items run in parallel via subagents; dependent items run sequentially.
- **Per phase gate:** `bun typecheck` and targeted `bun test` from the affected package directories (never repo root), plus manual smoke of any touched app pane, before the next phase starts.
- **End of program:** single no-ff merge into `dev`, push `dev` to origin, then a code review of the full branch diff performed by the model `meta/muse-spark-1.3` via `opencode run` (verify model availability at that step; surface alternatives to the user if unavailable).

## Phases

### Phase 1 — Finish the supervision loop

| # | Item | Type | Origin | Effort |
|---|------|------|--------|--------|
| 9 | Background subagent stop/steer from the subagent list | Fix | Claude agent-view, Codex panel | small |
| 8 | Local `/review` presets (base-branch, uncommitted, commit), no-mutation detached delivery | Feature | Codex code-review | small |
| 1 | Review return path: last-turn scope, inline comments → "address comments" follow-up, hunk stage/revert | Fix | Codex review pane | medium |
| 2 | Disposable per-chat worktrees with retention + checkout handoff | Fix | Codex git-worktrees | medium |
| 3 | One activity inbox: running / needs-input / blocked across dispatch, routines, sessions | Feature | Codex Activity, Claude agent view | medium |
| 4 | Permission hardening: separate sandbox from approvals, hidden full-access, auto-approve reviewer | Fix | Codex sandboxing, Claude permission modes | medium |

Notes:
- Item 9 builds on `tool/session-manage.ts` and `tool/message.ts` plus the existing app subagent list; stop/steer must target the active process-local ownership chain per the V2 Session Core rules (idle/missing interruption is a no-op).
- Item 8 reuses the command template system (`src/command/`, `review-preset.ts`); reviewer prompt must never mutate the working tree; delivery is a separate session the user opens.
- Item 1 extends `hunk-apply.ts` / `hunk-revert.ts` and existing review line comments; the "address these comments" action composes the next prompt from the session's inline comments scoped to the selected diff range.
- Item 2 builds on `src/worktree/` (index, retention, session-binding, bound-sessions); adds per-session disposable worktrees under the configured worktree dir, keep-N retention policy in the `worktree` config block, and explicit checkout handoff Local ↔ Worktree without losing session context.
- Item 3 is app-side: a single inbox view unifying the three existing thin lists (dispatch capped list, routines run state, unfocused-window notifications) with derived states running / needs-input / blocked.
- Item 4 builds on `core/src/v1/config/permission.ts` (already has `sandbox` and `approval` keys), `src/permission/sandbox.ts`, `evaluate.ts`, and the `permission.ask` plugin hook. Isolation (readonly / workspace-write / full-access) becomes orthogonal to consent (manual / accept-edits / auto); full-access plus auto approval is hidden in settings until explicitly enabled; an auto-approve reviewer may approve eligible boundary crossings without expanding the sandbox.

### Phase 2 — Local reach

| # | Item | Type | Origin | Effort |
|---|------|------|--------|--------|
| 5 | Browser pane beside diff with annotate-to-chat | Feature | Codex browser, Claude browser pane | large |
| 7 | Global quick-entry composer | Feature | Claude quick entry | small |
| 11 | On-disk opt-in memories with redaction | Feature | Codex memories | small |
| 13 | Multi-folder local projects with primary folder | Feature | Codex multi-folder | medium |
| 14 | Subagent isolation in temp worktrees + per-agent model/sandbox overrides | Feature | Claude subagents, Codex custom agents | medium |
| 15 | Hooks parity audit + gap fill | Feature | Codex hooks GA, Claude hooks | small–medium |

Notes:
- Item 5 is the largest item and the flagship of this phase: embedded browser on a separate profile beside the diff, click/drag region annotate, send into the session composer. Builds on `browser-pane.tsx`, `review-browser.tsx`, and the `preview` server config block.
- Item 7: global hotkey raises the composer window using the desktop quick-entry and deep-link paths that already exist; attach screenshot/window context where the OS makes it cheap (X11/Wayland portal on Linux; best-effort elsewhere — no new screen-recording machinery).
- Item 11: `src/memory/` (memory, extract, redact) already exists but is off by default and not self-curating. This item upgrades it to Codex-style memories: automatic curation during work, skipped on short sessions (reuse `min_turns`), redaction retained, on-disk only, never synced.
- Item 13: sessions may reference multiple folders with one primary folder owning git / AGENTS discovery and config resolution; workspace placement rules unchanged (V2 rules still apply).
- Item 14: agent frontmatter gains `isolation: worktree` and optional `model` / `sandbox` overrides; worktree isolation reuses the phase-1 disposable worktree lifecycle.
- Item 15 is **verify-first**: a config hooks module (`core/src/v1/config/hooks.ts` with PreToolUse, PermissionRequest, PostToolUse, SessionStart/End, Pre/PostCompact, UserPromptSubmit, SubagentStart/Stop, Stop, Interrupt) appears to exist and the earlier report claiming it missing may predate it. Phase opens with a coverage audit versus the Codex/Claude hook event list; implementation fills only real gaps.

### Phase 3 — Awake on user hardware

| # | Item | Type | Origin | Effort |
|---|------|------|--------|--------|
| 6 | RRULE cadence + run history for routines, targetable at sidecar or deepthought | Fix | Codex automations | medium |
| 10 | Non-interactive mode with JSONL stream + structured output for CI | Feature | Codex exec | medium |
| 12 | Phone needs-input delivery without vendor cloud (LAN + deepthought relay) | Fix | Codex mobile, Claude remote control | medium |

Notes:
- Item 6: the existing routines plugin (30-second poll, manual + dailyAt only, last-run record) gains RRULE cadences (`rrule` dependency already present), persisted run history, and target selection (desktop sidecar vs deepthought host) — scheduling survives sleep by running on the always-on host, not a vendor cloud.
- Item 10: `run` command gains `--json` JSONL event streaming and a structured output schema option; resumable by session ID for two-stage CI pipelines. Follows the existing `session_input` durable admission model.
- Item 12: extends the LAN mobile gateway with a needs-input approval path relayed via deepthought when off-LAN. Must degrade gracefully when the relay is unreachable; network-dependent portions get graceful-failure tests, since physical cross-host testing cannot be done from this session.

### Phase 4 — Computer use (last, gated on Phase 2 item 5)

| # | Item | Type | Origin | Effort |
|---|------|------|--------|--------|
| 16 | Computer use: off by default, per-app allowlist, never self-approving | Feature | Claude CUA, Codex computer use | large |

Builds on the existing opt-in computer-use tool, desktop allowlist, and Electron implementation. Per-app consent per action tier; the agent can never approve its own computer-use permission prompts; strictly fallback status for GUI-only apps after the browser pane works.

## Conventions and constraints (applied throughout)

- Branch naming/commit style per AGENTS.md: `codex-parity-build`; conventional commits `type(scope): summary`.
- All new user-facing strings go through i18n dictionaries with a locale fallback module per feature (established convention in `packages/app/src/i18n/`).
- Tests run from package directories, never repo root. Minimal or no mocks; test real implementations.
- Effect V4 style: bind services to named variables, no nested service yields; sync logic stays out of `Effect`; schema helpers preferred over manual `JSON.parse`.
- V2 Session Core rules: no bridging through legacy `SessionPrompt.loop`; durable admission respected; `SessionExecution` stays process-global and Session-ID based.
- Third-party plugins must be verified against the ollama-model-router before adoption (relevant if item 5 or 12 considers external MCP-based implementations).
- Deliberately skipped (unchanged from the report): vendor-hosted cloud sessions/environments, voice chat, Sites production hosting, Cowork-style knowledge-work home, Computer History screen recording, Gmail/Slack/GitHub webhook event triggers, vendor sign-in import as a prerequisite for supervision.

## Verification strategy

- **Per item:** unit tests adjacent to the code where the package already has that pattern (e.g. `*.test.ts` beside Electron main modules, Bun tests in `packages/opencode`).
- **Per phase:** `bun typecheck` + affected package tests + manual smoke of touched panes (review pane, worktree dialogs, inbox, settings, browser pane, routines UI, mobile gateway UI, computer-use settings).
- **End of program:** typecheck across all touched packages, full merge to `dev`, push, then Muse Spark 1.3 review of the branch diff with findings addressed before declaring parity work done.

## Risks

1. **Item 5 (browser pane) is large** and sits at the front of Phase 2; if it balloons, it is split into its own spec cycle rather than delaying the phase indefinitely.
2. **Item 12 (relay) cannot be hardware-tested here** — implementation must be defensive (timeouts, graceful offline behavior) and its tests cover degradation paths.
3. **Item 4 touches the permission core** — highest blast radius of the 16; design review within the phase plan will re-read `permission/evaluate.ts` consumers before changing schema semantics, and `sandbox`/`approval` config keys already exist, so this is a semantic enforcement change, not a schema-breaking change.
4. **Item 15 may already be done** — verify first to avoid duplicate machinery.
5. **Context scale:** 16 items is a lot; subagent isolation per item and phase gates keep any single context bounded.

## Out of scope

Everything in the report's explicit skip list plus any vendor-cloud adaptation beyond the deepthought-targeted features named above.