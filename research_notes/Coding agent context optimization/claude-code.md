# Claude Code — Context Window & Token-Usage Optimization (research notes)

Compiled 2026-10-19 for the Flynncode comparison report. State of the world as of Oct 2026;
the latest Claude Code release observed in the official CHANGELOG is **v2.1.304**.

Method: ~13 web fetch/search calls targeting official sources first
(`code.claude.com/docs/...` — NOTE: the old `docs.claude.com/claude-code/*` URLs 404; the
canon is `code.claude.com`), plus local mining of the official `anthropics/claude-code`
CHANGELOG (cached locally; the mirror strips dates, so entries are cited by **version number**
and ordered newest→oldest, i.e. higher line numbers = older). Never repeat-queried the same
source. Budget note: this file had ~13 web calls (limit 15).

Labeling convention used throughout:
- plain text = **documented fact** (official docs/changelog/blog, accessed 2026-10-19)
- **[COMMUNITY-UNVERIFIED]** = found only in reverse-engineering write-ups/repos, not in official sources
- **[SNIPPET-UNVERIFIED]** = seen only in a search-result snippet, page not fetched
- each mechanism notes **default-on vs opt-in**.

---

## 1. What occupies the context window each turn

### 1.1 Official illustration of the startup block
`code.claude.com/docs/en/context-window` ships an interactive simulation with **illustrative
token counts** (docs say counts are illustrative; real numbers vary by config, model, and
setup). At the configured default of `MAX = 200000` tokens, the pre-conversation block is
drawn as roughly **20% of a 200k window**:

| Block | Illustrative size | Loaded when |
|---|---|---|
| System prompt | ~4,200 tokens | Always, at startup; invisible to the user |
| Auto memory (`MEMORY.md`) | ~680 tokens (first **200 lines or 25 KB**, whichever is smaller) | Startup |
| Environment info | ~280 tokens (working dir, platform, shell, OS version, git-repo flag; git branch/status/recent commits form a separate block) | Startup |
| MCP tools, deferred (names only) | ~120 tokens | Startup; schemas only on tool use (see §3.2) |
| Skill descriptions (listing) | ~450 tokens total (descriptions truncated at **1,536 chars** in the listing) | Startup; skill *bodies* only on invocation (§3.1) |
| User `~/.claude/CLAUDE.md` | ~320 tokens | Startup |
| Project `CLAUDE.md` | ~1,800 tokens (docs recommend keeping CLAUDE.md **under ~200 lines**) | Startup |
| Path-scoped rules (`.claude/rules/*`) e.g. api-conventions ~380, testing ~290 | ~670 total | **Lazily** — only when working with files whose paths match (since v2.0.64) |
| File reads / tool results | e.g. 2,400 + 800 + 3,100 tokens per `Read` invocations | Just-in-time; the dominant occupant in real sessions |
| MCP/skill tools inside a subagent context | ~970 tokens | Subagent's own window (§4) |

System-prompt size has been actively reduced too — changelog: "Reduced system prompt size by
1.4k tokens" (v2.0.11).

### 1.2 Tool-output caps (hard ceilings that bound per-turn growth)
- **MCP tool results**: warning at **10,000 tokens**, hard cap **25,000 tokens** per output
  (override with `MAX_MCP_OUTPUT_TOKENS`); results **> 50k chars are persisted to disk and
  replaced by a file reference** (v2.1.2 changed truncation→persist-to-disk; v2.1.51 lowered
  the threshold from 100k to 50k "to reduce context window usage"). Servers can raise the
  persistence ceiling per-tool via annotation `_meta["anthropic/maxResultSizeChars"]` up to
  500K (v2.1.91) — that costs context, it does not save it.
- **Bash output**: truncated past a **30,000-character "inline limit"** (changelog v2.1.205–207
  mentions the "30K inline limit"; `ctrl+r` in the UI shows full output of long tool results —
  that UI affordance dates back to v0.2.54).
- **`@`-file mentions**: contents truncated at **2,000 lines** (raised from 100 lines in v1.0.53);
  `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` disables text-insertion entirely — mentions then pass
  **paths, not contents** (v2.1.299), deferring the read (and cost) to the model's own Read call.
- **Read tool**: max 2,000 lines per call; over-limit reads return a "**[PARTIAL]**" view with an
  explicit offset/limit continuation note (v2.1.145); oversized image reads are refused by size.
- **Hook output**: `additionalContext` over **10,000 chars is written to a file**, only a short
  preview enters context (docs/context-window page).
- 1M and larger-token contexts: a **1M-token context window** is available in Claude Code
  (session-management article, Apr 15 2026); the sim's default stays 200k, statusline reports
  `exceeds_200k_tokens` (v1.0.88) and the window may show >200k usage.

### 1.3 Environment economics (from docs/en/costs)
- Average enterprise cost ≈ **$13 per developer per active day** (≈$150–250/dev/month);
  90% of users spend < $30/day. `/usage` (merged from `/cost`+`/stats`, v2.1.118) shows session
  token stats; model pricing is configurable (`modelPricing`).
- Extended thinking is **default-on** and billed as output tokens.
- Prompt caching is automatic; subscriptions get **1-hour cache lifetime** vs the **5-minute**
  API default (§6.2).

---

## 2. Compaction

### 2.1 Automatic compaction (plain "auto-compact")
- Present since the 0.2.x era: changelog "**Automatic conversation compaction** for infinite
  conversation length" (undated mirror; sits between v0.2.54 and v0.2.21 headers — ["v0.2.x,
  mid-2025"]). Opt-out historically via flag; current: `--autocompact` flag,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (e.g. `200k`/`1M`, with `k`/`M` suffixes and out-of-range
  warnings, v2.1.304).
- The auto-compact **warning threshold** moved **60% → 80%** of the window (v1.0.51) and
  compaction became effectively **instant** when triggered (v2.0.64: "instant auto-compacting").
- **Manual & guided compaction**: `/compact` accepts custom instructions (e.g. keep
  architecture decisions); a `# Compact instructions` section in `CLAUDE.md` is honored at
  compaction (docs/en/costs).
- What survives (Sep 29 2025 engineering blog, *Effective context engineering for AI agents*):
  compaction preserves "**architectural decisions, unresolved bugs, and implementation details
  while discarding redundant tool outputs**". The docs' illustrative math: the summary is about
  **12% of the summarized tokens**; it keeps *requests/intent, concepts, files examined/modified
  (with important snippets), errors and fixes, pending tasks, current work*; drops full tool
  outputs and intermediate reasoning. Then Claude Code **re-reads up to five of the most
  recently modified files and re-injects the skill bodies you invoked** (each capped ~5,000
  tokens); the skill *listing* is **not** re-sent; system prompt, CLAUDE.md, memory, and MCP
  tool definitions reload automatically (code.claude.com/docs/en/context-window).
- Failure-mode hardening around compaction: fixed "Context limit reached"/"Payload is too
  long" when stopping mid-compaction (v2.1.296), compaction loop behind LLM gateways (v2.1.301),
  `prompt_too_long` from ignoring prior compact boundaries (v2.0.31), token-limit errors in
  summarization (v1.0.77), todo-list preservation during compaction (v1.0.11).

### 2.2 Idle compaction (cache-aware); default-on
Added v2.1.299: a **200k+-token conversation that sits idle ~54 minutes gets compacted before
the 1-hour prompt cache expires** (compaction invalidates the cache — see §6.2 — so doing it
*while idle* means zero lost work and the next request starts on a fresh cheap prefix).
`/config` gained an "Idle compaction" row (v2.1.302); off-switch: `"idleCompaction": false`;
threshold env: `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`.

### 2.3 Microcompaction **[COMMUNITY-UNVERIFIED]**
Reverse-engineering of the bundled CLI (community write-ups, e.g.
`github.com/claytonsandham/claude-code-internals`) describes a *tool-result-level* clearing
layer that runs **before** full auto-compact, from about v2026.01:
- Old tool results are cleared mid-session (before hitting the window edge); plausible
  `COMPACTABLE_TOOLS` set per recon: **Read, Shell/Bash, Grep, Glob, WebSearch, WebFetch, Edit,
  Write**; cleared results replaced by a sentinel like "[Old tool result content cleared]".
- A "cached microcompact" variant allegedly uses Anthropic's `cache_edits` API so clearing
  doesn't invalidate the prompt cache.
- Session-memory compaction: preserve ~10k tokens of session memory, cap ~40k.
All of this is community-sourced; I did not confirm it in official docs. Treat numbers as
provisional.

### 2.4 Server-side compaction (API beta) — see §7.3
The API docs position **server-side compaction** as the *primary* long-conversation strategy
(now), with tool-result/thinking clearing as the fine-grained alternatives. `compact-2026-09-04`
beta marker seen only in a search snippet **[SNIPPET-UNVERIFIED]**; the context-editing doc
links to `platform.claude.com/docs/en/build-with-claude/compaction`.

---

## 3. Progressive disclosure (load only what the turn needs)

### 3.1 Agent Skills
- Mechanics (docs/en/skills, Apr 2026): the skill *listing* (name + description + `when_to_use`,
  frontmatter description truncated at **1,536 chars**) is the only standing cost; the full
  `SKILL.md` body loads **only when the skill is invoked** — "long reference material costs
  almost nothing until you need it". Custom slash commands were merged into the skills system
  (`.claude/commands/deploy.md` ≡ `.claude/skills/deploy/SKILL.md`), so command definitions accrue
  no listing cost either. Bundled skills include `/doctor`, `/code-review`, `/batch`, `/debug`,
  `/loop`, `/claude-api`, `/verify`, and the open standard is
  [agentskills.io](https://agentskills.io).
- **Opt-in/off-ramps**: `disable-model-invocation: true` keeps a skill completely out of model
  context until the user types `/name`; `user-invocable: false` hides it from users;
  `context: fork` runs the skill inside a subagent context (backgrounded by default);
  `paths:` frontmatter loads body only for matching files; `allowed-tools`/`disallowed-tools`
  scope tool access.
- Costs aren't zero after loading: once invoked, a skill's content **stays in context for the
  rest of the session** ("every line is a recurring token cost"); `/reload-skills` sends only
  new or changed skills (v2.1.303); after `/compact`, only *invoked* skill bodies are re-injected
  (cap 5,000 tokens each) — listing does not reload (context-window doc).

### 3.2 MCP tool search (ToolSearch / MCPSearch) — default-on
- Docs (costs) state the principle: for MCP tools, "**only tool names and server instructions
  enter context until Claude uses a specific tool**"; schemas arrive on first use. This became
  **default-on for all users at v2.1.7** ("when MCP tool descriptions exceed 10% of the context
  window they are automatically deferred and discovered via the MCPSearch tool"; opt out by
  putting `MCPSearch` in `disallowedTools`). Threshold is tunable: `ENABLE_TOOL_SEARCH=auto:N`
  (N = % of window, v2.1.9); `alwaysLoad: true` per-server config bypasses deferral (v2.1.121);
  on Vertex it was disabled by default due to a beta-header error (v2.1.119, opt in with
  `ENABLE_TOOL_SEARCH`); with a custom `ANTHROPIC_BASE_URL` it is again default-on (v2.1.304).
- Loading is presented to the model as **stub/deferred tool definitions** (`defer_loading: true`,
  tool name only) discovered via tool search — per the Anthropic harness blog (Apr 2026, §6.2),
  this exists so tool sets *can* change mid-session without breaking cache consistency rules.
- Cache/integrity interplay: global system-prompt caching works with ToolSearch incl. MCP
  users (v2.1.84); fixed `--resume` full cache miss for deferred-tools users (v2.1.90); fixed
  deferred tools losing input schemas after compaction (v2.1.76); fixed tool-search missing
  late-connecting MCP servers (v2.1.122).

### 3.3 CLAUDE.md / rules / memory files
- User + project `CLAUDE.md` are loaded **fully at startup** (no partial-loading mechanism found
  in official docs; a recurring community claim that "long CLAUDE.md files are read partially"
  was **not** confirmed — mark unverified). Recommendation instead: keep CLAUDE.md short
  (<200 lines) and move procedures into skills. **[COMMUNITY-UNVERIFIED: partial CLAUDE.md reads]**
- The progressive-disclosure analog that *is* documented: **`.claude/rules/*`** — path-scoped
  rules that only load when working files match their prefix (v2.0.64), plus the **two-layer
  memory design**: `MEMORY.md` indexes "learnings" above the 200-line/25KB loader into separate
  files that Claude **reads on demand** — memory writes are explicitly steered toward the index
  (docs/en/memory; write over the read limit → explicit error v2.1.210). AGENTS.md works in
  place of CLAUDE.md if desired. `/memory` edits imported memory files directly.
- WebFetch sufficiency: the *research task* asked whether the default prompt forbids re-fetching
  the same URL. Not found in official docs; **[COMMUNITY-UNVERIFIED]** (community prompt dumps
  describe such hygiene directives).

---

## 4. Subagents & context isolation
- Docs/en/sub-agents: subagents run with **their own context window**, custom system prompt,
  tool allowlist and independent permissions; the Task tool returns **only a summary** to the
  parent — "use when a side task would flood the main conversation" (verbose searches, logs,
  bulk file reads).
- The **Explore agent** (introduced v2.0.17), powered by Haiku, formalizes this: cheap targeted
  code exploration whose results don't pollute the main model's window; Apr 2026 harness blog:
  prefer exploring via a Haiku subagent over switching models mid-session.
- Task tool results now carry **token count / tool uses / duration** metrics (v2.1.30).
- Skills with `context: fork` reuse the same isolation (backgrounded subagent context).
- `--forward-subagent-text` / `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` lets headless sessions
  receive subagent text output explicitly (v2.1.211).
- Illustrative subagent block (context-window doc): own system prompt ~900 tokens, own CLAUDE.md
  copy (Explore/Plan subagents skip it), MCP+skills listing ~970, task prompt ~120, file reads
  inside, returns a summary (~420 tokens) + metadata header.
- Blog (Sep 2025): subagent digests typical ~**1,000–2,000 tokens** of "compressed, relevant
  information" returned to the main thread; guidance: use them only when it helps (isolating
  heavy stuff), one clean "shoebox" per focused side task.

---

## 5. Tool-use hygiene directives (anything that caps/write-protects the window)
- Truncation ceilings — see §1.2 (MCP 10k/25k, 50k→disk, bash 30k, @-mentions 2,000 lines,
  Read 2,000 lines, hook output >10k chars → file).
- Docs + changelog push toward *deferred* reads (file references rather than dumping content),
  `ctrl+r` for full output instead of re-reading large outputs into the transcript (v0.2.54),
  and persisted tool results surviving `--resume` runs with all `tool_use`/`tool_result` pairs
  intact (fixes file in v2.1.x: v2.1.88, 2.1.101, 2.1.80 etc.).
- Process memory hygiene for extremely long sessions (v2.1.208): MCP stdio stderr accumulation
  (up to 64 MB per server), LSP docs pinned (now LRU with a 50-doc cap), async hook output
  retained after backgrounding, headless/SDK growth from large tool-result payloads.

---

## 6. Session-level mechanisms

### 6.1 Visibility you are *supposed* to keep
- **`/context`** visualizer — added v1.0.86; v2.0.74 regrouped the display by source
  (skills/agents/command listings), sorted by token count; fixed duplicate counting of thinking
  blocks (v2.0.8).
- **Status line** integration: `exceeds_200k_tokens` (v1.0.88) → context-window +
  `percentage` info via newer hooks (v2.0.65); status line JSON now includes **`current_usage`**
  (v2.0.70), which also shipped a **~3x memory-usage improvement for long conversations**
  (flexible front-end chunking rather than ever-growing DOM structures).
- `/usage` consolidated (v2.1.118).

### 6.2 Prompt caching as architecture (the load-bearing detail)
- Anthropic harness blog, "*Lessons from building Claude Code — Prompt caching is everything*"
  (claude.com/blog, Thariq Shihipar, Apr 30 2026) is effectively the canonical statement of the
  policy; docs/en/prompt-caching complements it.
- Core rule: caches are maintained on **exact prefix match** — every edit inside the prefix
  invalidates everything after it, so the agent framework pins an **ordering**:
  1) model-drive block **static system prompt + tool definitions** — immutable and first,
     shared by ALL users (global, aggressively cached);
  2) `CLAUDE.md`-like static agent context — pinned to a project/session and attached before
     the conversation starts (analogy given: reading the operating manual before boarding);
  3) **session context** (environment, MCP instructions, output style) — fixed per-session
     chunk attached before messages; and
  4) the conversation itself, which only appends.
- Operational rules derived from that ordering:
  - **Never add/remove tools mid-session** — plan mode is invoked via a tool (EnterPlanMode/
    ExitPlanMode) *inside* the same tool schema, not by swapping tool sets; optional tools are
    surfaced as `defer_loading: true` stubs resolvable via tool search (see §3.2).
  - **Don't change models mid-session** — cost regression to an uncached turn; if you need a
    cheaper/faster model (e.g. Haiku), send it through a **subagent** (which shares only
    summaries) rather than switching mid-conversation.
  - Prefer **appending as user-visible messages** over mutation: dynamic state arrives as
    `<system-reminder>` tags appended to the **next user message / tool result**, instead of
    editing earlier prompt blocks.
  - **Compaction must not break the cache**: compaction "forks" from the parent by reusing the
    parent's *entire static stack* (system + CLAUDE.md-style content + session content + tool
    definitions) and appending the compaction prompt as the **final user message**; the result
    is a summary (~20k tokens in the blog's figure) that becomes the seed of a fresh prefix —
    preserving the shared/global cache layers across compactions.
  - Cache lifetime: **1h on subscription plans vs 5m default** on API; shorter-TTL (~5m)
    compactions destroy the "aha" smoothness if you leave the conversation idle, hence
    idle compaction (~54 min, §2.2).
- Anthropic monitors **cache hit rate** and declares internal SEVs for regressions — treat the
  hit rate as a product health metric, not a nicety.
- Cache-status and cost visibility is exposed via `/usage`, statusline hooks (§6.1) and
  response `usage` statistics (docs/en/prompt-caching).

### 6.3 Session branching instead of window-burning
- Session-management article (claude.com/resources/articles/using-claude-code-session-mgmt,
  **Apr 15 2026**): with a **1M-token window** and "context rot" as the backdrop, the options
  each user turn are effectively: **continue**, **`/rewind`** = "esc esc" (restores code +
  prompt state to an earlier checkpoint), **`/clear`** (jettison everything), **compact**
  (summarize then continue), or **dispatch to a subagent**. The framework steers users toward
  rewind/branching over frantic compaction.
- **`/rewind` = checkpointed undo shipped in v2.0.0** (changelog: "Unwinds your code and
  conversation to an earlier state"); bugs fixed around it: skills-list-restore after `/rewind`
  (v2.1.301).

### 6.4 Memory (cross-session compression via *external* files)
Two sanctioned mechanisms (docs/en/memory), both simply loaded as context, never as config:
1. **CLAUDE.md family** — user/project/local/`AGENTS.md` instructions, plus path-scoped
   `.claude/rules/*` (lazy per §3.3), and `#`-quick-nostalgia CLI based memory approved by the
   user (the `#` shortcut was later removed in v2.0.70).
2. **Auto memory** (Claude-written learnings): `MEMORY.md` index + per-topic detail files
   (read on demand), per-repository entry scope, per-worktree sharing on worktrees, 200 lines/
   25 KB loader — over-limit writes produce an explicit error (v2.1.210).
- Docs push enforcement concerns to `PreToolUse` hooks rather than bloating CLAUDE.md with
  "must NEVER" rules that the model must re-read every turn.

---

## 7. The API substrate underneath (context management betas)

Announcement "Elephant in the room: built-in context management" — Anthropic Press,
**Sep 29 2025** (public betas, incl. Bedrock/Vertex):
- **Context editing** — automatically clear stale tool uses/results as the limit approaches.
  Internal agentic-search benchmark: memory tool + editing **+39%** over baseline; editing
  alone **+29%**.
- **Memory tool** — file-based, client-executed memory directory that survives sessions
  (all-caps rules: the model can inspect/edit externally via file commands mid-conversation —
  matches §6.4).
- **100-turn web-search benchmark: editing alone completed otherwise-failing workflows while
  consuming ~84% fewer tokens**.
- **Sonnet 4.5** introduced built-in context awareness (knows its window %).

### 7.1 API `context_management` parameter (beta `context-management-2025-06-27`)
Fetched 2026-10-19 from `docs.claude.com` (canonical: platform.claude.com/docs/en/
build-with-claude/context-editing). Editing is **server-side**: the client keeps its full
history; the API Edits the prompt before it reaches Claude. Config takes
`edits: [ ... ]` in the Messages API (all beta `betas=["context-management-2025-06-27"]`):

**`clear_tool_uses_20250919`** (tool result clearing):
- `trigger `{type:"input_tokens", value: N}` — fire clearing when context passes N.
- `keep` `{type:"tool_uses", value: N}` — always preserve the N most recent tool_* pairs.
- `clear_at_least` `{type:"input_tokens", value: N}` — failing the feather-in-a-broom note:
  ensure at least N tokens are cleared per eviction so the (inevitable) cache invalidation is
  worth its cost.
- `exclude_tools: [...]` — never clear these tools' results (e.g. pinned file reads).
- `clear_tool_inputs: true` — also strip the tool *calls*, not just results.
- Cleared items are replaced by **placeholder text** ("cleaned") in chronological order.

**`clear_thinking_20251015`** (thinking-block clearing):
- `keep` `{type:"thinking_turns", value: N}` or `"all"`; default by model class: **all** for
  Opus 4.5+/Sonnet 4.6+/Haiku 5.5+ (and Fable/Mythos), "last turn only" for earlier classes.
- Caching note: kept thinking blocks preserve the cached prefix; cleared ones invalidate it
  from that point — so `keep` is the dial between cache cost and window cost.
- Ordering constraint: when combining strategies, `clear_thinking_20251015` must be first in
  the `edits` array.
- Thinking-block replay safety: server-side context management never invalidates thinking
  blocks on Fable 5.1/Opus 5.5/Sonnet 5.5/Haiku 5.5; client-side edits *can*, and for accounts
  created after Aug 31 2026 replaying an invalidated block is rejected unless you opt into
  dropping it.

### 7.2 Claude Code exercises these natively
Evidence chain (no blog claim needed): docs (§6.2) say tool sets can mutate mid-session via
`defer_loading` stubs; the changelog (v2.1.304) says "Fixed `context_management: Extra inputs
are not permitted` errors behind LLM gateways; Claude Code now **resends the request without
that field**" — i.e. production Claude Code sends an API-side `context_management` field
(context editing on the wire) and retries gracefully with gateways that don't support it.

### 7.3 Server-side compaction (API)
- The context-editing doc cross-links **`/build-with-claude/compaction`** and calls
  server-side compaction "**the primary strategy for managing context in long-running
  conversations**" — the API runs the summarization and swaps history server-side.
- **[SNIPPET-UNVERIFIED]** search result showed beta marker `compact-2026-09-04` with
  on-demand and threshold-triggered modes; not fetched (budget). Follow up before citing.

---

## 8. Economics / takeaways for a competitor's design doc

Facts worth copying as *design goals* (all sourced above):
1. Pin the prefix: static-shelf-first prompt layout + hard "no mid-session tool-set/model
   mutation" rules = high cache-hit discipline (blog Apr 2026).
2. Progressive disclosure as the default posture for *all* heavy catalog objects: MCP tool
   schemas (deferred by default), skills (body-on-use, 1,536-char listing truncation),
   rules (path-scoped), memory detail files (index+lazy).
3. Multiple compaction layers with different granularity and cost/staleness tradeoffs:
   idle compaction (free, opportunistic), auto/manual compaction (12%-size summary + 5-file
   reread), claimed micro-compaction of tool results [COMMUNITY-UNVERIFIED], and server-side
   compaction/context editing on the API wire.
4. Every "keep it forever" object must earn its tokens each turn (@-mentions, skill bodies,
   MEMORY.md) with hard caps/persistence-to-disk fallbacks (50k→file, 30k, 2,000 lines,
   200 lines/25 KB).
5. Back-pressure for extreme sessions handled at the process layer too (LRU LSP docs, stderr
   caps, session-file compaction v2.1.30 68% resume-memory reduction), not just in the window.
6. Checkpoints (`/rewind`) as the primary breaker against wasted context, *before* compaction,
   plus per-turn branching menu surfaced in docs.

---

## 9. Sources (all accessed 2026-10-19 unless marked)

Official docs (code.claude.com):
- `/docs/en/context-window` — interactive context composition sim + compaction math
- `/docs/en/costs` — economics, tool-search deferral default, CLAUDE.md guidance, idle
  compaction, compact knobs
- `/docs/en/prompt-caching` — cache mechanics, invalidations, TTLs
- `/docs/en/memory` — CLAUDE.md vs auto memory, MEMORY.md 200 lines/25 KB, rules, /memory
- `/docs/en/sub-agents` — Task-tool isolation contract
- `/docs/en/skills` — SKILL.md lifecycle, 1,536-char listing truncation, disable-model-invocation,
  context: fork
- `/docs/en/mcp` — MCP config (truncated page; tool-search defaults captured via cost doc +
  changelog)
Blogs / announcements (anthropic.com / claude.com):
- *Effective context engineering for AI agents* — Sep 29 2025 engineering blog (blog appears
  across engineering site + claude.com mirror)
- *Elephant in the room: built-in context management* press/blog — Sep 29 2025 (eval numbers)
- *Lessons from building Claude Code — Prompt caching is everything* — claude.com/blog,
  Thariq Shihipar, Apr 30 2026 (cache ordering, fork-compaction, tool mutation rules)
- *Using Claude Code Session Management, Compaction & 1M Context* — claude.com/resources/
  articles, Apr 15 2026 (per-turn branching options, /rewind esc-esc, 1M window)
API substrate:
- `docs.claude.com/en/docs/build-with-claude/context-editing` (canonical
  platform.claude.com/docs/en/build-with-claude/context-editing), beta
  `context-management-2025-06-27`; links `/build-with-claude/compaction`
  [`compact-2026-09-04` seen only in snippet]
Changelog:
- `github.com/anthropics/claude-code` CHANGELOG.md (cached copy at
  `~/.local/share/opencode/tool-output/tool_156d136ed001W2MWaVWvZ1TvXf`, spans 0.2.x→2.1.304;
  undated mirror, cited by version)
Community (unverified, used cautiously):
- `github.com/claytonsandham/claude-code-internals` (microCompaction/sentinel recon, §2.3)
- Generic community write-ups of the default system prompt (brevity directives,
  WebFetch-sufficiency) — not located in a primary source this session

## 10. Open questions for the report writer
1. Whether "partial CLAUDE.md reads" is real (community claim; rules/memory lookup found but
   not CLAUDE.md) — needs a primary prompt/source dump or fetch of `docs/en/memory` more
   deeply.
2. Exact microcompaction semantics (§2.3) — is it official today? Community-only as of
   writing; wait for a primary source or vendor blog.
3. Server-side compaction details (§7.3) — fetch `/build-with-claude/compaction` for modes/
   parameters of the `compact-2026-09-04` beta.
4. Default system prompt exact text (brevity clauses, `WebFetch` sufficiency rules, "prefer
   Read over cat/sed") — community prompt-dump repos; not an official artifact.
5. Changelog mirror lacks dates for versions 0.2.x–2.1.x; if the report needs ISO dates,
   grep the upstream repo web UI or the RSS release feed rather than this mirror.
