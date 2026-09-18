# Model Router: Evidence-Based Model Cards and Selectable Routing - Design

Date: 2026-09-18
Status: Implemented (2026-09-18)

Implementation note: the card table's `planning` tag on Fable 5.1/Opus 5 was
implemented as `architecture` only, following the user's instruction to reserve
premium escalation models for unusually complex work. Routine planning resolves
to Opus 5 only when it wins on score; the automatic planning pool does not
reserve Fable/Astra.

## Problem

The router works, but its model policy is thin and its activation is invisible:

1. Only three models have scorecard entries. Anthropic, OpenAI, and most
   Ollama Cloud models appear in `opencode models` yet are invisible to the
   router because candidate discovery reads only `provider.*.models` from
   merged config; connected catalog providers never enter the pool.
2. The router can only be enabled by editing `opencode.jsonc` and restarting,
   then it silently rewrites built-in agent models. The user wants routing to
   be a first-class selectable model, with concrete model selection bypassing
   it entirely.
3. There is no premium escalation lane. Astra and Fable 5.1 should be
   reserved for very complex issues and designs, not routine work, and there
   is no `architecture` task to express that.
4. Superpowers and other plugins must keep working unchanged when a concrete
   model is chosen, and should also be able to override routed choices when
   they supply a model themselves.

## Goal

- A "Model Router" virtual model is selectable in the normal model picker and
  becomes the default selection; choosing any concrete model bypasses
  routing for that session.
- Every canonical paid model on Anthropic, OpenAI, and Ollama Cloud gets an
  evidence-based scorecard entry derived from the September 2026 models.dev
  catalog (prices) plus reasoned capability/speed estimates.
- A new `architecture` task reserves Fable 5.1 (primary) and GPT-6 Astra
  (premium alternative) for complex design work.
- `review` is explicit, pinned to Claude Sonnet 5, with Luna as cheap
  secondary.
- Coding/debugging routes to DeepSeek V4.1 Flash, with GLM 5.3 Flash as the
  close fallback. Routine planning routes to GLM 5.3.
- Plugins keep their existing model freedom; the router never fights an
  explicit plugin-provided model.

## Research Summary (September 2026 catalog)

Source: models.dev API snapshot plus `opencode models` from the locally
authenticated Flynncode build. 63 selectable IDs were examined across
anthropic, openai, ollama-cloud, and opencode providers. Key facts used:

- Prices are USD per million tokens (in/out); Ollama Cloud adds cache_read.
- Anthropic tiers: Sonnet 5 (2/10), Sonnet 4.5/4.6 (3/15), Opus 4.5-5 and
  Fable 5 (5/25), Fable 5.1 (5/25 but cache_read 0.25 vs Fable 5's 1.0),
  Haiku 4.5 (1/5).
- OpenAI tiers: Luna 5.6 (0.2/1.2), mini 5.4 (0.75/4.5), Codex Spark
  (1.75/14), Terra 5.6 (2/12), GPT-5.4 (2.5/15), Sol 5.6 (4/20), GPT-5.5
  (5/30), Astra (10/50, >272K 20/75). Fast modes are 2-6x base.
- Ollama Cloud: deepseek-v4.1-flash (0.15/0.6), glm-5.3-flash (0.15/0.5),
  gemma4:31b (0.14/0.4), nemotron-3-ultra (0.1/3), deepseek-v4-flash
  (0.22/0.66), minimax family (0.3/1.2), deepseek-v4-pro (0.66/1.98),
  mistral-large-3 (0.5/1.5), qwen3.5 (0.6/3.6), kimi-k2.x (0.95/4),
  glm-5.2/5.3 (1.4/4.4), kimi-k3 (3/15).
- All 1M-context Ollama models: deepseek family, glm-5.3/5.3-flash,
  kimi-k3, nemotron-3-nano. OpenAI 5.4+/5.6/Astra are 1.05M. Anthropic
  Sonnet 4.5+/Opus 4.6+/Fable are 1M; older Opus/Haiku 200K.
- Kimi K2.5 and MiniMax M2.5 have no published prices; scored conservatively
  mid-price (6) rather than treated as free.
- Synthetic `-fast` IDs (gpt-6-astra-fast etc.) and dated snapshots
  (deepseek-v4-flash:0731, deepseek-v4-pro:0813, claude-opus-4-5-20251101,
  etc.) are aliases; excluded from routing, documented here.
- OpenCode free tier (big-pickle, ling-3.0-flash-fin-free, mimo-v2.5-free,
  muse-spark-1.2/1.3-contributor-free, nemotron-3-ultra-free,
  nemotron-3.5-lightning-free) is excluded from routing by decision.

## Scoring Rubric

Cards carry integer 1-10 scores for price (1 = cheap), capability, and speed.
Tags restrict which tasks a model can win when unpinned.

- price: log-bucket of input-heavy blended cost per million tokens. 1 <=
  ~0.20 blended, 2 ~0.2-0.4, 3 ~0.4-0.8, 4 ~0.8-1.2, 5 ~1.2-2, 6 ~2-3.5,
  7 ~3.5-6, 8 ~6-12, 9 ~12-25, 10 > 25. Blended = 3x input + 1x output / 4.
- capability: reasoned estimate from tier, release recency, tool/reasoning
  support, context, and known specialization. These are planning estimates,
  not vendor guarantees; the spec records them so future tuning is
  auditable.
- speed: flash/mini/nano models 8-9, mid 5-7, premium reasoning 3-5.

### Canonical cards

| Model | price | cap | speed | tags |
|---|---|---|---|---|
| anthropic/claude-sonnet-5 | 5 | 9 | 7 | review, writing |
| anthropic/claude-sonnet-4-6 | 6 | 8 | 6 | writing, review |
| anthropic/claude-haiku-4-5 | 4 | 6 | 8 | lookup, writing |
| anthropic/claude-opus-4-6 | 7 | 9 | 4 | planning |
| anthropic/claude-opus-5 | 7 | 10 | 3 | planning, architecture |
| anthropic/claude-fable-5-1 | 7 | 10 | 4 | architecture, planning |
| anthropic/claude-fable-5 | 9 | 10 | 3 | architecture |
| openai/gpt-5.6-luna | 1 | 7 | 8 | review, writing, lookup |
| openai/gpt-5.4-mini | 2 | 6 | 8 | lookup, writing |
| openai/gpt-5.3-codex-spark | 4 | 8 | 7 | coding |
| openai/gpt-5.6-terra | 4 | 8 | 6 | coding, planning |
| openai/gpt-5.4 | 5 | 8 | 5 | coding, planning |
| openai/gpt-5.5 | 7 | 9 | 4 | planning, architecture |
| openai/gpt-5.6-sol | 6 | 9 | 5 | review, planning |
| openai/gpt-6-astra | 9 | 10 | 3 | architecture |
| ollama-cloud/deepseek-v4.1-flash | 1 | 7 | 9 | coding, lookup |
| ollama-cloud/glm-5.3-flash | 1 | 7 | 9 | coding, lookup, long-context |
| ollama-cloud/glm-5.3 | 4 | 8 | 5 | planning, review, long-context |
| ollama-cloud/deepseek-v4-flash | 2 | 6 | 8 | coding, writing, lookup |
| ollama-cloud/deepseek-v4-pro | 4 | 7 | 5 | coding, planning |
| ollama-cloud/glm-5.2 | 4 | 7 | 5 | planning |
| ollama-cloud/kimi-k3 | 8 | 9 | 4 | planning, architecture |
| ollama-cloud/qwen3.5:397b | 4 | 7 | 4 | writing, planning |
| ollama-cloud/gemma4:31b | 2 | 5 | 6 | writing, lookup |
| ollama-cloud/minimax-m3 | 3 | 6 | 5 | writing |
| ollama-cloud/kimi-k2.7-code | 5 | 7 | 5 | coding |
| ollama-cloud/nemotron-3-ultra | 2 | 6 | 5 | lookup |
| ollama-cloud/nemotron-3-super | 1 | 4 | 7 | lookup |
| ollama-cloud/gpt-oss:120b | 1 | 5 | 6 | lookup |
| ollama-cloud/gpt-oss:20b | 1 | 3 | 7 | lookup |
| ollama-cloud/mistral-large-3:675b | 3 | 6 | 4 | writing |
| ollama-cloud/kimi-k2.6 | 5 | 7 | 5 | planning, review |

Excluded from cards by decision: dated snapshots, `-fast`/`:cloud`
duplicates, `claude-opus-4-5` (superseded by 4.6+ at same price),
`claude-sonnet-4-5` (superseded by sonnet-5 at lower price), kimi-k2.5 and
minimax-m2.5/2.7 (unpriced or superseded), nemotron-3-nano (ultra/super
cover it), gpt-5.6-sol (kept mid-tier but not on a winning lane). The list
above is the automatic pool.

### Task weights

- coding: 0.6 capability / 0.25 price / 0.15 speed (unchanged default)
- planning: 0.7 / 0.2 / 0.1 (unchanged default)
- review: 0.65 / 0.25 / 0.1 (unchanged default)
- lookup: 0.3 / 0.3 / 0.4 (unchanged default)
- writing: 0.5 / 0.3 / 0.2 (unchanged default)
- long-context: 0.6 / 0.3 / 0.1 (unchanged default)
- architecture (new): 0.9 capability / 0.05 price / 0.05 speed

### Expected winners with these cards

- coding: deepseek-v4.1-flash; glm-5.3-flash runner-up
- planning: glm-5.3; terra competitive
- review: claude-sonnet-5 (pinned)
- architecture: claude-fable-5-1 (pinned); gpt-6-astra or opus-5 runner-up
  by score; pinned lane guarantees fable primary regardless of near ties
- lookup: glm-5.3-flash or deepseek-v4.1-flash by tie-break
- writing: gpt-5.6-luna by score; sonnet-5 close
- long-context: glm-5.3-flash
- Pins in `taskModels` enforce review and architecture primaries regardless
  of close scores.

## Plugin Changes (packages/opencode/src/plugin/ollama-model-router)

- `TaskName` gains `architecture`; it is a valid tag, task weight, pin, and
  `route_task` target. Settings payload and language strings gain it.
- Candidate discovery (`candidates.ts`) is extended to accept an optional
  connected-provider catalog (the resolved `Provider.list()` shape) in
  addition to raw `provider.*.models`. The tools and `assignAgents` pass the
  catalog when available; raw config remains the fallback so tests and
  headless use keep working. Synthetic aliases listed in the research
  summary are excluded via the scorecard's absence plus `allowUnscored:
  false`.
- New `model-router/auto` virtual model, injected via the plugin `config`
  hook (not a `provider.models` hook, which requires a models.dev catalog
  entry):
  - The plugin's config hook adds provider ID `model-router` with display
    name "Model Router" and one model `auto` (tool_call, reasoning, 1M
    context) to `cfg.provider` before provider resolution reads it. It is
    always considered "connected" (no auth required) and excluded from its
    own candidate pool.
  - Variants: `auto` (default, follows the active agent's task), plus one
    variant per task name that forces that task's winner. Variant names are
    the task names themselves.
  - The plugin's `config` hook no longer rewrites built-in agent models by
    default: `agentTasks` still maps agents to tasks for the `auto`
    variant, but assignment changes from mutating `cfg.agent` to resolving
    at prompt time. `overrideExplicit` keeps its legacy meaning only when
    the user sets `legacyAssign: true` (new option, default false).
- Prompt-time resolution: a new `chat.message` hook detects the sentinel
  (`model-router/auto`) on the incoming user message and rewrites
  `output.message.model` to the concrete winner for the active agent's task
  (or the chosen variant's task). The sentinel itself remains the session
  and agent selection preference so the picker keeps showing Model Router on
  later turns; only transcript messages carry the concrete model. Global
  `model` becomes `model-router/auto`, but `small_model` stays a concrete
  cheap model (ollama-cloud/glm-5.3-flash) because the small-model path has
  no chat.message trigger point and must never see the sentinel.
- The built-in router registers first (it is already the first internal
  plugin in hook order). If a later hook or the caller supplies a concrete
  model, `chat.message` sees a non-sentinel model and does nothing; the
  router also must not overwrite a model another plugin has already
  rewritten inside the same trigger loop (check output before writing).
- `rank_models`/`route_task` behavior is unchanged apart from the new task
  name and catalog-aware candidates. `route_task` child sessions run on the
  concrete winner as today.

## Settings Editor Changes (packages/app/src/components/settings-v2)

- `model-router-payload.ts` mirrors the plugin: `architecture` task,
  `legacyAssign` flag (default false), and the new cards/pins as data.
- Routing tab preview uses the connected catalog when the server provides
  it, matching runtime candidate discovery.
- The task grid gains Architecture with the "quality-first" priority preset.

## Default Configuration (opencode.jsonc)

- `model_router.autoRoute` stays true but now only feeds the auto variant;
  the global `model` key becomes `model-router/auto`. `small_model` stays
  concrete (`ollama-cloud/glm-5.3-flash`) — see the resolution section.
- `allowUnscored: false` so only carded models route.
- `taskModels`: review -> anthropic/claude-sonnet-5, architecture ->
  anthropic/claude-fable-5-1.
- `providers`: ["ollama-cloud", "anthropic", "openai"].
- `disabled_providers` keeps ollama-local disabled; the router provider is
  synthetic and unaffected.

## Error Handling

- If routing has no eligible concrete model (all excluded), prompt admission
  fails visibly with the task and exclusion reasons; it never falls through
  to a synthetic provider URL.
- Runtime provider failures after routing are not automatically replayed on
  the runner-up; tool-call side effects make replay unsafe. `rank_models`
  exposes the runner-up; retries are explicit.
- Unknown or missing sentinel variant falls back to the agent-mapped task.
- If the sentinel appears but the router is unconfigured, admission fails
  with a clear message rather than sending `model-router/auto` to an API.
- The synthetic provider is not added to auth flows or provider onboarding;
  it is skipped by the settings provider pickers and by the router's own
  candidate collection.

## Verification

- Plugin unit tests: architecture task parsing/ranking, catalog-aware
  candidates, sentinel injection, variant mapping, concrete-model bypass,
  external-plugin override precedence, pinned task winners.
- App payload/preview tests for the architecture task and connected catalog
  preview parity.
- CLI smoke: `bun run ./src/index.ts models` shows `model-router/auto`;
  `rank_models` output shows the new winners table.
- Live: routed prompts for coding (deepseek-v4.1-flash), review (sonnet-5),
  architecture (fable-5-1); a concrete-model session shows no routing.
- Browser: Model Router is the default picker choice; selecting Sonnet 5 or
  DeepSeek keeps that model for the session; transcript shows the concrete
  model used per turn while the picker keeps showing Model Router.

## Out of Scope

- Live re-routing without restart.
- Automatic replay/fallback on provider errors.
- Price or benchmark auto-discovery from the network.
- Routing inside subagent task tools (subagents keep their own configured
  models; Superpowers' choices are untouched).