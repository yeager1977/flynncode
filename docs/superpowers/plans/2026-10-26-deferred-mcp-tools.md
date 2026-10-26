# Deferred MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send only MCP tool names when many MCP tools are enabled, and load full definitions on demand through a `tool_search` tool, like Claude Code's ToolSearch.

**Architecture:** A pure deferral helper (`packages/flynncode/src/mcp/defer.ts`) decides per turn which visible MCP tools are sent vs deferred from the threshold, per-server `defer` config and the session's loaded set. `SessionTools.resolve` uses it to omit deferred tools and add `tool_search`; `SystemPrompt.mcp` adds a sorted deferred-names block. `tool_search` (`packages/flynncode/src/tool/tool-search.ts`) searches/loads tools (reusing code mode's scoring) and merges ids into session metadata `mcpLoaded`. The invalid-tool repair returns a "load it first" hint for unloaded deferred tools.

**Tech Stack:** TypeScript, Effect 4 beta, AI SDK, bun test, SolidJS app.

**Spec:** `docs/superpowers/specs/2026-10-26-deferred-mcp-tools-design.md`

## Global Constraints

- Threshold: `experimental.mcp_defer_threshold` (default 15). Defer when the count of VISIBLE (after `Permission.disabled`) MCP tools is > threshold; threshold 0 defers all. `mcp.<server>.defer: false` → that server never deferred; `defer: true` → always deferred. Env `OPENCODE_DISABLE_MCP_DEFER=1` disables deferral. Experimental code mode on → no deferral (MCP tools already hidden).
- Built-in tools are never deferred. `tool_search` exists only while at least one tool is deferred.
- `tool_search { query: string, max_results?: number }`: `select:a,b` exact ids; otherwise keyword search over name + description (reuse `packages/codemode/src/tool-runtime.ts` search scoring/tokenizer — import or extract a shared helper; don't duplicate logic); `max_results` default 5, max 20; output cap ~25 KB (then names-only + "narrow your query"); no match → suggest closest names; returns full description + parameter JSON schema; marks matched ids loaded.
- Loaded set: session metadata `mcpLoaded: string[]`; merge-safe writes (read current metadata, spread, set) — never clobber other keys; read per provider step (the run loop fetches `session` once per run — re-read metadata each step or keep an in-memory set updated by `tool_search` and seeded from metadata); drop ids that no longer exist; sub-agent sessions start empty.
- Deferred-names block: sorted, grouped by server, names only, placed next to `<mcp_instructions>` in `packages/flynncode/src/session/system.ts` `SystemPrompt.mcp` (~152-167), filtered by permissions; stable across turns unless tool lists/permissions change.
- Unloaded deferred tool call → existing `experimental_repairToolCall` (`packages/flynncode/src/session/llm.ts` ~296-311) path returns a result telling the model to load it with `tool_search` first (no error).
- `tool_search` never bypasses permissions; loaded tools still ask on call as before.
- Repo style (AGENTS.md): no `any`, no import aliases or star imports, `const` over `let`, no `else`, bind Effect services to variables, comments only for non-obvious constraints, self-export pattern. Tests from package dirs; `bun typecheck` from package dirs. Never write your own files under `/tmp` (TMPDIR=$HOME/.cache/flynncode-test-tmp, delete after). Leave no processes running.
- Shared checkout: stage explicit paths only; never `git add -A`/`git stash`. DO NOT edit `packages/flynncode/src/tool/{code-mode,computer-use,memory,message,session-manage,task}.ts` — if needed, STOP and report BLOCKED. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Config and the deferral helper

**Files:** `packages/core/src/v1/config/mcp.ts` (add optional `defer: boolean` to Local + Remote + the toggle-only entry if applicable), `packages/core/src/v1/config/config.ts` (`experimental.mcp_defer_threshold`), `packages/flynncode/src/effect/runtime-flags.ts` (`disableMcpDefer` from `OPENCODE_DISABLE_MCP_DEFER`), create `packages/flynncode/src/mcp/defer.ts` + `packages/flynncode/test/mcp/defer.test.ts`. Regenerate the legacy SDK if the config schema is part of the public API (stage only related generated changes).

**Interfaces:** `McpDefer.plan(input: { tools: string[] /* visible MCP tool ids */; servers: Record<string, { defer?: boolean }>; serverOf: (id: string) => string; threshold: number; loaded: ReadonlySet<string>; disabled: boolean }): { sent: string[]; deferred: string[] }` — pure, sorted outputs.

- [ ] Failing tests: 16 visible → all deferred except `defer:false` servers and loaded ids; 15 → none deferred (unless `defer:true` servers); threshold 0; `disabled` → none; loaded ids always sent. Implement; tests + typecheck (core, flynncode). Commit `feat(flynncode): decide which MCP tools to defer`.

### Task 2: `tool_search` and the loaded set

**Files:** create `packages/flynncode/src/tool/tool-search.ts` + `.txt`; a small session-metadata helper for merge-safe `mcpLoaded` updates (e.g. `packages/flynncode/src/mcp/loaded.ts`); extract/export a reusable search scorer from `packages/codemode/src/tool-runtime.ts` (keep codemode behavior unchanged) or import it; tests `packages/flynncode/test/tool/tool-search.test.ts`.

The tool needs the current deferred catalog (ids, descriptions, schemas) — take it from the MCP service (`MCP.tools()` defs) filtered by permissions/deferral the same way Task 3 does; design the tool so Task 3 can construct it per turn with the deferred list (e.g. a factory taking the deferred defs) rather than registering it globally in `registry.ts`.

- [ ] Failing tests: `select:` exact load (+ stale name → "no such tool" for that name); keyword ranking; `max_results` default/max; output cap; no-match suggestions; loaded ids merged into metadata without clobbering other keys (pre-seed metadata with `worktree`/`sandbox` keys). Implement; tests + typecheck. Commit `feat(flynncode): add tool_search for deferred MCP tools`.

### Task 3: Turn integration

**Files:** `packages/flynncode/src/session/tools.ts` (`SessionTools.resolve` ~546-660: compute visible MCP ids → `McpDefer.plan` → add only sent tools + `tool_search` when anything is deferred; code mode bypass), `packages/flynncode/src/session/system.ts` (`SystemPrompt.mcp` deferred block), `packages/flynncode/src/session/prompt.ts` (loop: make the loaded set current per step — re-read session metadata or maintain an in-memory set seeded per run and updated by `tool_search`), `packages/flynncode/src/session/llm.ts` (repair hint for unloaded deferred tools); tests in `packages/flynncode/test/session/` using a real local MCP test server fixture (find existing MCP tests/fixtures, e.g. under `test/mcp/`) and the test LLM server (`test/lib/llm-server.ts`).

- [ ] Failing tests: with >15 visible MCP tools the request's tool list omits deferred tools and includes `tool_search`; the system prompt has the sorted deferred block; after the model calls `tool_search select:x` the next provider step's request includes `x` and a call to `x` succeeds in the same turn; the loaded set survives a new run (reload) and compaction; denied tools never listed/loadable; a sub-agent session starts empty; calling an unloaded deferred tool returns the hint; code mode → no deferral; env flag → no deferral; below threshold → unchanged request. Implement; `bun test test/session test/mcp test/tool` (relevant) + typecheck. Commit `feat(flynncode): defer MCP tools and load them on demand`.

### Task 4: App

**Files:** `packages/session-ui/src/components/message-part.tsx` (register a compact `tool_search` renderer: "Loaded N MCP tools: a, b, …" from the tool result/metadata — have Task 2's tool return metadata `{ loaded: string[], query }` if it doesn't already; coordinate by reading tool-search.ts), MCP status "Deferred" badge only if the app already has an MCP status surface that can learn deferral cheaply (otherwise skip and note), i18n keys in `packages/app/src/i18n/en.ts` + `flynncode-fallback.ts` (and `packages/ui/src/i18n/*` if session-ui strings live there), browser test for the pure card helper.

- [ ] Failing browser test → implement → browser suite + i18n tests + typecheck (app, session-ui, ui) → prettier on touched files only → commit `feat(app): show tool_search loads compactly`.

### Task 5: Spec sync and verification

- [ ] Update the spec where implementation differs; run `cd packages/flynncode && bun test test/session test/mcp test/tool test/config && bun typecheck`, `cd packages/core && bun typecheck`, `cd packages/app && bun test --conditions=browser --preload ./happydom.ts ./test-browser && bun typecheck`, `cd packages/session-ui && bun typecheck`; classify failures without `git stash`. Commit the spec: `docs: sync deferred MCP tools spec with the implementation`.
