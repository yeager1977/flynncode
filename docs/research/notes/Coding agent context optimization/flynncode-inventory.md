# Flynncode context mechanism inventory

Static, read-only code inventory of how the Flynncode repo (fork of opencode, bun + Effect-TS monorepo) builds and spends model context. All claims come from code actually read; nothing was executed. Approximate token counts are characters ÷ 4 (estimate only, no tokenizer run).

Two generations coexist and this matters for every finding:

- **V2 session core** (the strategic path per root `AGENTS.md`): `packages/core/src/session/**`, wired live in `packages/flynncode/src/server/routes/instance/httpapi/server.ts` (`SessionV2.node` line 77, `SessionExecution.node` + `SessionExecutionLocal.node` lines 78–81/314/340) and `packages/flynncode/src/effect/app-runtime.ts:126–129`.
- **V1 legacy pipeline**: `packages/flynncode/src/session/*.ts` (uses `SessionV1`), still carrying its own compaction, truncation, reminders, and prompt-assembly code.

## 1. Inventory

| Mechanism | Files / symbols | Behavior | Default |
|---|---|---|---|
| System-context algebra | `packages/core/src/system-context/index.ts` (`Source<A>`, `combine`), `registry.ts` (`SystemContextRegistry.load` sorts entries by key, reloads all sources per turn) | Every named source renders baseline; changes announce `update(...)` blocks; disappearance announces `removed` text | Always on |
| Environment + date built-ins | `packages/core/src/system-context/builtins.ts` (`core/environment`, `core/date` under `core/builtins`) | `<env>` block: working dir, workspace root, git-repo yes/no, platform; plus "Today's date" line | Always on |
| Instruction discovery (V2) | `packages/core/src/instruction-context.ts` (`core/instructions`, `observe`, `fetchRemote`) | Walks up from cwd to project root collecting every `AGENTS.md` (all levels), plus global config `AGENTS.md`, plus config `instructions` entries (globs walked upward, absolute paths, remote URLs fetched with 5 s timeout, failures skipped). Rendered as `Instructions from: <path>\n<content>` | Only if files exist |
| Instruction discovery (V1) | `packages/flynncode/src/session/instruction.ts` (`resolveBasePaths`, `extract`) | Chain `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `CONTEXT.md` but **first level where any match wins**; global `AGENTS.md` else `~/.claude/CLAUDE.md` (unless `disableClaudeCodePrompt`); global + project `MEMORY.md`; re-resolved every turn; re-attaches previously-read files after upstream compaction via `read` tool `loaded` metadata (skips `time.compacted`) | Only if files exist |
| Memory tool | `packages/flynncode/src/tool/memory.ts` + `memory.txt` | Durable convention notes: `global` scope and `project` scope (`.opencode/memories/`, commitable); writes require user approval; `MEMORY.md` files are attached as instruction context via V1 instruction resolver | Opt-in per write |
| Skill guidance + skill tool | `packages/core/src/skill/guidance.ts` (`core/skill-guidance`), `packages/core/src/tool/skill` | System context lists skill names + descriptions in `<available_skills>`; bodies load on demand wherever the skill dir lives | Empty list if none |
| Project references | `packages/core/src/reference/guidance.ts` (`core/reference-guidance`) | `<available_references>` name/path/description for extra directories; read-only | Empty if none |
| Knowledge notes prologue | `packages/core/src/session/knowledge.ts` (`buildKnowledgePrologue`, `listTitles`) | For `kind === "knowledge"` sessions only: `.opencode/knowledge/*.md` titles listed (slug-sorted for cache stability), bodies read on demand | Never in code sessions |
| Agent system prompts | `packages/core/src/plugin/agent.ts`: `BUILD_SYSTEM` (default), `PROMPT_EXPLORE`, `PROMPT_COMPACTION`, `PROMPT_TITLE`, `PROMPT_SUMMARY`, `PROMPT_KNOWLEDGE` | Agents defined/overridden in config (`system` field); built-ins here; subagents have `mode: "subagent"` | Default agent = 2-sentence generic coding prompt |
| Per-provider prompt texts (V1) | `packages/flynncode/src/session/prompt/*.txt` selected by session/system.ts `provider()` | Provider-specific full text prompt files (see sizes below) | One per provider |
| Tool set per turn | `packages/core/src/session/runner/llm.ts` (`tools.materialize(agent.info?.permissions, location.directory)`), registries under `packages/core/src/tool/` (21 modules) and `packages/flynncode/src/tool/` (29 modules) | Tool definitions filtered by agent **permissions only** — built-in, MCP, LSP, web search tools; no token-budget-based pruning | All permitted tools |
| Prompt caching | `packages/llm/src/cache-policy.ts` (`AUTO { tools: true, system: true, messages: "latest-user-message" }`), applied in `packages/llm/src/route/client.ts:345` (`applyCachePolicy`); `providerOptions.openai.promptCacheKey` + `x-opencode-session-id` headers in runner `llm.ts:214–226` | Caches tool schemas, system prompt, and latest user message on the native LLM route path; protocol bodies lower hints (e.g. Anthropic `cache_control`); `"none"` opts out | On (`auto`) |
| History selection | `packages/core/src/session/history.ts` (`loadForRunner`, `entriesForRunner`), `context-epoch.ts`, `packages/core/src/session/sql.ts` | SQL loads only rows from the latest compaction seq (or newer system rows above the epoch `baseline_seq`) — pre-compaction history never reaches the model | Always applied |
| Compaction (V2) | `packages/core/src/session/compaction.ts` (`compactIfNeeded`, `summarize`, `buildPrompt`, `select`, `serialize`), `settings()` merges config | Triggers: (a) proactively when estimated tokens ≥ `threshold` (default **0.9**) of model context, (b) hard at context − max(output, `buffer` 20 000). Serializes conversation to a compact pseudo-transcript with tool results capped at **2 000 chars**; model summarizes the `head` with a rigid markdown template (Objective / Important Details / Work State / Next Move / Relevant Files), merging a `<prior-summary>`; the **recent tail ≤ `keep.tokens` 8 000 stays in a `<recent-context>`** checkpoint message | Auto on; config `compaction.{auto,prune,keep.tokens,buffer,threshold}` (`packages/core/src/config/compaction.ts`) |
| Compaction execution | same file (`summarize` streams on `llm.stream`) | Runs on the session's **primary model**, no tools, ≤ 4096 output tokens; template ≈ 620 tokens; overflow retry loop via `TurnTransitionError` in `runner/llm.ts` | — |
| Overflow classification | `packages/llm/src/provider-error.ts` (~30 regex patterns, `isCompactWorthyFailure`, `isRepetitiveContent` reclassification) | Provider context-overflow errors (and README-identified `call_id` over-length schema failures) trigger one post-overflow compaction if no assistant output had started | Always |
| V1 compaction | `packages/flynncode/src/session/compaction.ts` (`PRUNE_MINIMUM` 20 000, `PRUNE_PROTECT` 40 000, protected `skill` tool outputs, `MIN/MAX_PRESERVE_RECENT_TOKENS` 2 000/15 000), `message-v2.ts` `filterCompacted` | Legacy in-place prune/summarize with message reordering | Auto on (`overflow.ts` respects `compaction.auto === false`) |
| Tool-output budget | `packages/flynncode/src/tool/truncate.ts` (`MAX_LINES` 2 000, `MAX_BYTES` 50 KiB, `write`, `TRUNCATION_DIR` 7-day retention), config `tool_output.max_lines/max_bytes` (defaults 2 000 / 51 200, `packages/core/src/v1/config/config.ts`) | Oversized tool outputs spill to disk with a preview + hint in the tool result | Always |
| Subagents (task tool) | `packages/flynncode/src/tool/task.ts`, `packages/core/src/tool/task.ts`, `packages/core/src/plugin/agent.ts` (built-in `general`, `explore` agents) | Child sessions carry their own context; `explore` denies everything but grep/glob/read/web tools; async `BackgroundJob` mode | — |
| Step limits | `packages/core/src/session/runner/max-steps.ts` (`MAX_STEPS_PROMPT`), optional `agent.steps` | On the capped step: tools are emptied, `toolChoice: "none"`, and a synthetic assistant message demands a text summary | Off unless agent steps set |
| Durable steering/queue | `packages/core/src/session/input.ts`, promoted in `runner/llm.ts` (`promoteSteers`, `promoteNextQueued`) | Steers promote at next safe boundary and reset the agent's provider-turn allowance; queued input promotes when the loop would idle | — |
| Small-model tier | `getSmallModel` (`packages/flynncode/src/provider/provider.ts:2089`) + plugin hook `experimental.provider.small_model` (`ollama-model-router/index.ts:280`, `github-copilot/copilot.ts:355`); callers: titles/summaries (`session/prompt.ts`), `permission/auto-reviewer.ts:66`, project-copy handler | Non-conversation tasks (titles, summaries, permission pre-review) go to a cheaper model if configured (priority fallbacks like `gemini-flash`, `gpt-nano`, `claude-haiku`) | Plugin/config dependent |
| Synthetic plan reminders (V1) | `packages/flynncode/src/session/reminders.ts` (`PROMPT_PLAN`, `PLAN_MODE${planInfo}`, `BUILD_SWITCH` — injected as `synthetic: true` parts on the last user message) | Plan-mode instructions and plan→build handoff injected each relevant turn; plan file path named | — |

## 2. Notable absences (only verified searches)

- **No local retrieval/embedding/RAG pipeline.** Searched `embedding|vector store|RAG|retrieval` across `packages/flynncode/src` and `packages/core/src`: only incidental hits (provider discovery skips embedding models, `provider/discover.ts:48`; GitHub Copilot passthrough for OpenAI-hosted `file_search` `tool/file-search.ts:92`; comments). Persistent knowledge is purely file-on-demand (`AGENTS.md`, `.opencode/memories/`, `.opencode/knowledge/`, `MEMORY.md`).
- **No tool-schema or context trimming by token budget.** Tool materialization is permission-filtered only (`tools.materialize(agent.info?.permissions, ...)`); there is no size-aware subset or lazy tool loading via "code-mode"-style indirection for MCP lists.
- **No summarizer model for V2 compaction.** `summarize()` streams the summary from the session's own primary model (`packages/core/src/session/compaction.ts:205–214`); cheap models are used for titles/prompt-summary tasks only in the V1 path (`getSmallModel` callers listed above). Searched `getSmallModel` in `session/summary.ts`: no match.
- **`compaction.prune` config is dead in V2.** The config schema accepts it (`packages/core/src/config/compaction.ts:12`) but V2 `settings()` merges only auto/buffer/keep.tokens/threshold (`packages/core/src/session/compaction.ts:129–138`). Old tool outputs are evicted only implicitly via the keep-window/summary rewrite, not pruned turn-by-turn.
- **No retry/dedup guard yet.** Runner TODO explicitly lists "Bound provider retries and repeated identical tool calls" unchecked (`packages/core/src/session/runner/llm.ts:57`).
- **No cache hints on the V1 AI-SDK path.** `packages/flynncode/src/session/llm.ts` / `llm/ai-sdk.ts` only account cache read/write tokens; `applyCachePolicy` executes inside the native `LLMClient` (route path used by the V2 runner). Searched `cache|Cache` in both files: no hint injection.
- **`plan-reminder-anthropic.txt` appears orphaned** (4 056 B file in `packages/flynncode/src/session/prompt/`; grep `plan-reminder` over all `.ts` sources: zero imports).
- **No git-state/primary-folder assertion + no hooks-in-context** were found in the V2 baseline: environment block is 4 facts (dir, root, git yes/no, platform) — no branch, no git status, no OS release info (search of `builtins.ts`, grep `Key.make("core/` shows the complete source set: 6 keys).

## 3. System prompt size / composition

**V2 per-turn system assembly** (`packages/core/src/session/runner/llm.ts:227–229`): `system = [agent.info?.system, system.baseline, knowledge]`.

| Part | Source | Rough size |
|---|---|---|
| Default agent prompt | `BUILD_SYSTEM` in `packages/core/src/plugin/agent.ts:15` | ~2 sentences |
| Environment block | `core/environment` | ~6 lines |
| Date line | `core/date` | 1 line |
| Skills | `core/skill-guidance` | ~25–40 tokens per skill listed |
| References | `core/reference-guidance` | ~25–40 tokens per reference |
| Instructions | `core/instructions` | Unbounded — every matching `AGENTS.md` is inlined in full |
| Knowledge prologue | `buildKnowledgePrologue` | Titles only, ~15 tokens per note |

**V1 provider prompt `.txt` sizes** (`packages/flynncode/src/session/prompt/`, bytes → est. tokens at 4 B/token):

| File | Bytes | Est. tokens |
|---|---|---|
| gemini.txt | 15 372 | ~3 840 |
| copilot-gpt-5.txt | 14 241 | ~3 560 |
| beast.txt | 11 080 | ~2 770 |
| gpt.txt | 9 284 | ~2 320 |
| meta.txt | 9 159 | ~2 290 |
| glm.txt | 9 005 | ~2 250 |
| kimi.txt | 8 695 | ~2 170 |
| default.txt | 8 528 | ~2 130 |
| anthropic.txt | 8 212 | ~2 050 |
| trinity.txt | 7 748 | ~1 940 |
| codex.txt | 7 390 | ~1 850 |
| gpt-astra.txt | 4 078 | ~1 020 |
| plan-mode.txt | 4 547 | ~1 140 |
| plan-reminder-anthropic.txt | 4 056 | ~1 014 |
| plan.txt | 1 484 | ~370 |
| build-switch.txt | 233 | ~60 |

Only one of the provider files applies per conversation; plan/mode texts are synthetic reminders. `MAX_STEPS_PROMPT` (injected as assistant message) is ~1.1 KiB (16 lines) ≈ ~275 tokens; the compaction summary template ≈ 30 lines / ~620 tokens; the compaction checkpoint message wraps `<summary>` + `<recent-context>` (≤ 8 000 tokens by default, `to-llm-message.ts:147–165`).

### Estimated composition for a typical V2 turn

1. Agent system prompt (small, unless user-configured)
2. `<env>` + date (~150 tokens)
3. Skills/references lists (linear in installed entries)
4. Full text of matching `AGENTS.md` chain + global instructions (unbounded, changes cached after first miss)
5. Newest user message (cached via `latest-user-message` policy), prior history from DB trimmed to the last compaction + system-updates
6. Full tool schema set the agent's permissions admit
7. After threshold: summary checkpoint + ≤ 8 000-token recent tail replace everything older
