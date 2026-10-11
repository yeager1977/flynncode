# Parity builds — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development. One implementer per lane, task review after each, whole-wave final review. Steps use checkboxes.

**Goal:** Implement the seven recommended parity builds from `docs/superpowers/specs/2026-10-05-flynncode-vs-codex-claude-latest.md`.

**Architecture:** Lanes are grouped so each implementer owns a disjoint file surface; lanes 1–3 are app+opencode, lane 4 is small config/plugins work that can run anytime.

**Global constraints (all lanes):**
- Tests from package dirs only; `bun typecheck` per touched package; conventional commits (`feat(app):`, `feat(opencode):`, `feat(plugin):`).
- NEVER hardcode user-visible English: all copy via `language.t`/`language.plural`; new keys → en.ts + matching fallback module (see `session-review-fallback.ts` pattern); i18n parity test must pass.
- No new runtime dependencies except `gh` CLI usage via existing shell/IPC patterns (no npm packages).
- Worktrees: reuse `packages/flynncode/src/worktree/index.ts` helpers; do not add a second worktree API.
- Effect code follows packages/flynncode/AGENTS.md (Effect.fn, ScopedCache, Flock for cross-process writes).
- SolidJS per packages/app/AGENTS.md (createStore over signals, keyed Shows, no physical margins).
- Do not touch cloud/web surfaces, do not fork notification code, do not add vendor sign-ins.

---

## Lane A — Preview-server lifecycle + auto-verify (M-L) — agent 1

Owns: `packages/app/src/pages/session/review-browser.tsx`, new `preview-server.ts` app-side; `packages/flynncode` preview config schema + server spawn helpers; i18n.

- [ ] 1. Config schema: add `preview` object to opencode config (packages/flynncode config schema, tolerant decode): `{ servers: [{ name, command?, args?, cwd?, port?, url?, autoPort? }] }`. Validate: either `command` (managed) or `url` (attach-only); `url` must be http/https, no userinfo, localhost with no path/query/port-mismatch errors.
- [ ] 2. Server-side lifecycle (packages/flynncode): plugin or service to start/stop/restart a configured server (spawn via existing child-process service; track child PID; stop kills process group). Endpoint `preview.servers` returning `{name, port, url, state: running|stopped|starting|failed, pid}`; actions start/stop/restart. Surface over existing experimental route group patterns.
- [ ] 3. App browser pane: server dropdown in review-browser header (name + state dot + start/stop/restart/edit-config menu). Attach to running server if `url` config is set (no spawn).
- [ ] 4. Auto-verify plumbing: when the agent edits files (subscribe to `file.edited` events scoped to the session directory), if a preview server config exists and `autoVerify` (derived from config, default true) is on, expose a tool `verify_page` to the model (screenshot via the existing capturePage IPC path server→app is out of scope — instead the server-side tool takes the running URL, fetches it, and returns HTTP status + title + console-error-free HTML check; screenshots stay in the app pane).
- [ ] 5. i18n: keys for all new UI copy (server dropdown, states, edit config, errors).
- [ ] 6. Tests: schema parsing matrix (valid/invalid/autoPort/url rules), lifecycle start/stop/restart against a real `bun`-served static file (use tmpdir), endpoint contract test, UI source-contract tests.

## Lane B — PR/CI monitor + auto-fix/auto-merge/auto-archive (M) — agent 2

Owns: `packages/app/src/components/session/session-header.tsx` area (new CI status strip component), `packages/flynncode` git/gh integration.

- [ ] 1. Prereq detection: `gh --version` + `gh auth status` on the session directory; surface "install gh" prompt (deep link to docs; no auto-install).
- [ ] 2. Server: detect PR for current branch (`gh pr view --json number,state,mergeable,statusCheckRollup,url`); endpoint returns PR + CI checks state. Poll on demand (app refetch) and on `git.push` events; no long-lived server polling.
- [ ] 3. App CI status bar under the session header: check names + states, links to PR; toggles: Auto-fix (asks agent to fix failing checks by feeding the failure output into the session — reuse existing steer/queue flow), Auto-merge (calls `gh pr merge --squash --auto`; show method and require repo setting confirmation), notification on CI finish (reuse notification path).
- [ ] 4. Auto-archive setting: settings key `cleanup.autoArchiveAfterPrMerge` (default off); when PR merges/closes and no running work, archive the session (reuse bulk archive op).
- [ ] 5. i18n keys + tests: endpoint contract (mock gh via script stub), UI source-contract tests, auto-archive decision unit tests.

## Lane C — Side chats + view modes (S-M) — agent 3

Owns: `packages/app/src/pages/session/timeline/*`, composer region, session page shell.

- [ ] 1. Side chat: `/btw` slash command opens a dock (composer region, like question dock) that reads the session context but submits to a side thread: persist NOT to disk (in-memory createMessage context object); visually distinct (border + label). Provide close and "return to main thread" behavior; main timeline unaffected.
- [ ] 2. View modes: add a view-mode select (Normal/Thinking/Verbose) to the session menu (near existing timeline controls), persisted per session view state (layout store `SessionView`); Normal = tool calls collapsed summaries (current default), Thinking = + thinking blocks, Verbose = + tool parts and intermediate. Implemented by filtering/part-listing in `rows.ts` row construction, not new data.
- [ ] 3. Keyboard: Cmd+; equivalent (mod+;) opens side chat; Ctrl+O cycles modes (command palette registrations).
- [ ] 4. i18n + tests: side-chat non-persistence behavior (reload clears), view-mode filter unit tests on rows.

## Lane D — Worktree settings + .worktreeinclude + OMO catalog 6.1 (S-M) — agent 4

Owns: `packages/flynncode/src/worktree/*`, worktree config schema, `packages/app` worktree UI bits + `omo-catalog.ts`.

- [ ] 1. Config: `worktree` object — `{ location: string (default ".claude/worktrees"), branchPrefix?: string, keep?: number (default 15, Codex keep-N) }`; validate location is inside project root or absolute path allowed by policy.
- [ ] 2. Worktree create/list/remove use config (rename existing hardcoded paths; retention limit from `keep`).
- [ ] 3. `.worktreeinclude` support: when creating a worktree, copy gitignored files listed in `.worktreeinclude` from the primary checkout (respecting the file's line patterns, like git status/ls-files semantics) — implement in create path after `git worktree add`.
- [ ] 4. Settings UI: worktree section in app settings (location picker, prefix text input, keep stepper) — i18n.
- [ ] 5. OMO catalog: add `gpt-6.1-sol` rungs (openai/vercel/opencode providers) at the flagship/balanced tiers above `gpt-6-sol` rungs; update `omo-config-payload` tests that assert the head model (`gpt-6-astra` stays flagship).
- [ ] 6. Tests: schema tests; include-file copy integration test (tmpdir git repo with `.worktreeinclude`, verify ignore-listed file present in the new worktree); retention keep-N test; catalog tests updated.

## Lane E — Cross-session rename/archive + task chips (M) — agent 5

Owns: `packages/flynncode/src/tool/message.ts` + session tools, `packages/app` subagent list area (`subagent-list-view.tsx`).

- [ ] 1. Server: session rename + archive operations callable by the agent from a tool context (extend the message tool family or add `session_manage` tool): list/read/rename/archive other desktop sessions (same-server, non-archived by default, 20 most-recent scope), following Claude's safety model: archive requires user approval in every permission mode (permission.ask with an `archive` action); never deliver to archived; never list the asking session.
- [ ] 2. Task chips: when a session's final/steered text includes a structured suggestion (`<task-suggestion>` envelope produced by the model prompt guidance in system prompt), render a chip in the timeline that, on click, starts a new session in its own worktree with that prompt (reuse handoff/new-session flow). Gate the prompt guidance behind the new session-tools availability.
- [ ] 3. App subagent list: show rename affordance (inline edit) on child session rows; archive action asks confirmation.
- [ ] 4. i18n + tests: tool contract tests (list scope excludes self, archive ask fired), envelope parse unit tests, chip render source-contract test.

---

## Sequencing

- Lanes A–E are file-disjoint enough for parallel implementers, EXCEPT: A and B both touch session-header region (B adds a strip under the header, A touches review-browser header only — no conflict expected; if collision occurs, B rebases).
- C and E both touch composer/timeline area mildly (C adds a dock; E adds timeline chips) — keep E's chips in rows.ts rendering and C's dock in composer region to avoid the same files.
- OMO catalog change (D5) is independent — smallest, ship first if any lane conflicts.
- Recommended dispatch order for serial execution: D5 → A → B → C → E → D1-4.
- Per-lane task review; whole-wave final review with cross-lane integration focus (especially A↔B session-header region and C↔E timeline).

## Acceptance

- All lanes: tests from package dirs pass; parity test for i18n passes; opencode/app/desktop typechecks clean.
- Demo paths: A — start a static server via config in review pane; B — open a PR'd branch and see checks; C — /btw side chat + verbose mode; D — create worktree carrying an ignored file; E — chip click creates a worktree session.