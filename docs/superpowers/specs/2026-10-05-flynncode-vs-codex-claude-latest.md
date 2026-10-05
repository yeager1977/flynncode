# Flynncode vs latest Codex & Claude Desktop — change and feature list

Date: 2026-10-05. Sources: OpenAI Codex changelog (fetched today, complete Feb→Oct 2026), Claude Desktop docs (code.claude.com/docs/en/desktop, latest), and the current Flynncode source (verified by grep/read, not the stale 9/30 inventory).

## Part 1 — What shipped IN Flynncode since the 9/30 research baseline

These landed via the sessions in this repo (commits on dev since 16a556b9c4):

| Change | Commit(s) | Parity effect |
| --- | --- | --- |
| **Dispatch activity inbox** — unread-on-transition (running→done/failed), All/Unread/Running/Waiting filters, unread badge, transition notifications via a persistently-mounted `DispatchActivityProvider` | e10c0e384e + d8778dafc4 fixes | This is Flynncode's version of Codex's July-2026 "Activity view + bell + Cmd/Ctrl+Opt+U" (`26.727`). |
| **Review browser annotation capture** — annotations now carry a page screenshot (desktop `webContents.capturePage` via new preload/main IPC) + rect; a "Re-check page" button re-fires; rect-only fallback on web | a019a91ce5 + fixes | Matches Codex's built-in-browser Annotate gesture (element/region comment into chat) for local dev servers. |
| **Artifacts typed union** — `diff/file/screenshot/note` artifact types with a persisted filter row (All/Changed/Screenshots/Notes), 100-item store cap, diff-only 20-group cap | 8f7e0731b3 + fixes | Closes the "screenshots have no home" gap before the Claude-style preview loop produces them. |
| **Routines cadence + recovery + run records** — `manual / {dailyAt} / {interval: 15m|1h|6h|1d|1w}`, missed-dailyAt recovery after restart, JSONL run records (last 200) under a flock, settings UI for intervals | 78b39d12f8 + 6e30e7788f | Steps toward Codex "Revamped Automations" (`26.312`) local shape: schedules + run history, app must run for local runs. |
| **Checkout handoff carries context** — `worktree-handoff {from,to}` endpoint (rejects identical/unknown paths, skips deleted files, carries dirty state), app-side flow archives the source session with moved-without-session toast, real error surfacing | bdecab1c56 + fixes | Matches Codex's Local↔Worktree handoff (`26.303`), which Claude lacks. |
| **Composer project indicator** — avatar + project name in the composer bottom bar; read-only popover with worktree path + session count; loading-aware | 44d923499f…65e66322e6 | Orientation feature both vendors have implicitly via sidebars; now explicit at the point of typing. |
| **Model family routing fixed** — family fallback reachable (disabled-provider gating, connected-only catalog, retryable catalog, ModelsDev-refresh invalidation), `model_family` tolerant in config | f862104b39 + 38091a40bb + others | Flynncode-specific router robustness (no vendor analogue). |
| **Bulk session cleanup** (home + sidebar) with cancel-safe runs, protected roots, truncation handling, skipped-reporting | c00b066fec et al. | Session hygiene; both vendors do archive-by-PR (Claude) — Flynncode now does bulk age-based cleanup. |
| **Terminal toggle in v2 session header** + TDZ fix | 8be8aa3415 + 16a556b9c4 | Parity with Claude/Codex terminal panes (toggle affordance). |
| **Background-activity divider & synthetic wake classification** (OMO wakes render as dividers, not fake user prompts) | 127f5905fc et al. | Cleaner timeline than either vendor's raw wake rendering. |
| **Dev release-base versions** | d1c62321d5 | infra. |

## Part 2 — What's new in Codex (Changelog, latest) that Flynncode lacks

Desktop-app and high-leverage changes only (full detail in research_notes):

1. **GPT-6.1 Sol default** (`26.159.1`, Sep 29) — bundled-catalog default model; also GPT-6 Sol/Luna tiers; Free/Go get Luna. Flynncode's OMO catalog already leads with GPT-6; consider adding `gpt-6.1-sol` rungs (the OMO catalog currently stops at 6.1-Sol? — verify against models.dev; the rungs list `gpt-6-sol`/`gpt-5.6-sol`).
2. **Pets + Quick Chat** (`26.908`, Sep 11) — floating companion with instant chat (Enter to send, `@` files, `$` skills), appshot to floating controls. Flynncode: no analogue (deliberate — the 9/30 note skipped Pets; keep skipping).
3. **Appshots on Windows** (`26.908`) — both-Alt-keys share frontmost window. Flynncode: none; the trait is quick screen-context sharing — the macOS double-Command gesture exists too. Optional.
4. **Agent command center** in CLI (`0.156.0`, `0.160.0`) — status filters + history pagination + worktree session creation from one surface. Flynncode's analogue is now Dispatch + bulk select (landed last 48h). Mostly covered.
5. **Guardian auto-review** — approval prompts routed through reviewer agent with risk level; Oct 1 added opt-in conversation-history retrieval + handoff-aware context. Flynncode: none. Candidate: route `permission.ask` auto-decision through a cheap router model when user enables "auto-review" (deepthought-style). Medium effort, router-friendly.
6. **Import flows** for Claude Code / Cowork / Cursor (`26.608`, `26.811`) — Flynncode HAS this (`settings.import.source.claudeCode / .codex`). Covered.
7. **Activity view** (`26.727`, Jul 30) — now covered by Lane 1 (above).
8. **Sites / Space / dots** — deliberately skipped per the 9/30 note (cloud products). Keep skipping.
9. **WebMCP / site tools** (`26.` Aug 25) — websites expose tools to the agent. Flynncode: none; low priority (requires GPT-5.6 Sol/Terra on their side).
10. **Record & Replay** (`26.616`) — demonstrated workflow → reusable skill. Flynncode: none. Optional, heavier.
11. **Voice** — skip per local-first rule.
12. **Linux desktop preview** (`26.` Aug 11) — Flynncode already builds Linux artifacts (today's build output confirmed). Covered.

## Part 3 — What's new in Claude Desktop that Flynncode lacks

1. **Preview-your-app browser pane with dev-server management** — Claude starts/stops dev servers via `.claude/launch.json` (`runtimeExecutable/args/port/cwd/env/autoPort/program/url`), auto-verifies after every edit (screenshots/DOM/clicks/forms), persists cookies across restarts ("Persist sessions"), and can attach to a server you already run via `url` config. **Flynncode has a ReviewBrowser pane (iframe + annotations) but no dev-server lifecycle, no launch.json, no auto-verify loop.** This is now the biggest single gap for the Claude-style local loop. The Lane 2 capture tool gives screenshots; the missing piece is server start/stop + verification loop.
2. **PR monitoring: CI status bar, auto-fix, auto-merge** — Claude polls check results via `gh`, offers auto-fix of failing CI and auto-merge on green, plus desktop notification on CI finish, and auto-archive when the PR merges. Flynncode: no PR/CI surface found. Medium effort (needs GitHub connector or `gh` CLI), high user value.
3. **Side chats (`/btw`, Cmd+;)** — ask a question with session context without adding to the main thread; not saved to disk. Flynncode has steers and peer messages but no side-chat surface. Small-medium effort.
4. **Cross-session work by Claude itself** — Claude can list/read/rename/archive other desktop sessions, send messages to them (with cards, inbound controls, quoted attribution), and suggest task chips for out-of-scope work (click → new session with own worktree). Flynncode has session-to-session messaging (`MessageTool`, landed previously), plus the 48h bulk select; missing the Claude-initiated rename/archive + task-chip surface. Medium effort.
5. **SSH sessions** — run on remote machines through the same UI with per-host identity files; enterprise `sshConfigs`/allowlist. Flynncode's analogue: attach to remote HTTP servers + WSL sidecars (different mechanism, similar role). Partially covered.
6. **View modes** (Normal/Thinking/Verbose per transcript) — Flynncode's timeline has no transcript verbosity toggle. Small effort.
7. **Worktree location + branch-prefix settings** — Claude lets users set the worktree directory and a branch prefix; Flynncode's retention is fixed at 15 in `retention.ts`. Small effort; pairs with Codex's keep-N-worktrees setting (`26.227`).
8. **Worktree gitignored-file carry via `.worktreeinclude`** — Flynncode: not found. Small effort.
9. **Auto-archive after PR merge/close** — pairs with (2). Small effort once PR monitoring exists.
10. **Usage ring (context % + plan usage)** — Flynncode has a session-context-usage component; parity exists. Covered.
11. **iOS Simulator pane** — macOS-only; skip for now (Flynncode is Linux-first today).
12. **Cloud sessions / Dispatch-spawned from phone** — directionally reserved for deepthought hosting per the 9/30 note; LAN gateway covers the local path. Keep the position, not the cloud.
13. **Computer use with per-app tiers** — both vendors ship it; Flynncode skipped per local-first risk analysis. Keep skipping until browser-first loop (1) works.

## Recommended next builds (ordered)

1. **Preview-server lifecycle + auto-verify** (Claude's launch.json + auto-verify loop): Flynncode's review browser gains "start/stop/restart server" backed by a `flynncode.json` `previewServers` config, wiring to `Terminal`/PTY for logs, and an optional "Verify" tool the agent can call (screenshot + console errors). Biggest visible gap vs Claude. Effort: M-L.
2. **PR/CI monitor + auto-fix/auto-merge/auto-archive**: `gh`-based status bar in the session header (reuse existing GitHub connector or `gh` binary on PATH), auto-fix on red, squash auto-merge on green (only if the user's GitHub setting allows), auto-archive on merge. Effort: M.
3. **Side chats (`/btw`)**: read-only-context chat pane, not persisted. Effort: S-M.
4. **Transcript view modes** (Normal/Thinking/Verbose) driven by the existing timeline rows. Effort: S.
5. **Worktree settings** (location, branch prefix, keep-N retention, `.worktreeinclude` support in create). Effort: S-M.
6. **Claude-style cross-session actions** (rename/archive via session tools — partially exists through `MessageTool`; add rename + chip-suggestion surface). Effort: M.
7. **OMO catalog**: add `gpt-6.1-sol` tier rungs to match the new Codex default. Effort: S.
8. Optional/later: Guardian-style auto-review via router cheap-model; Record & Replay; Appshot-style window share; WebMCP.