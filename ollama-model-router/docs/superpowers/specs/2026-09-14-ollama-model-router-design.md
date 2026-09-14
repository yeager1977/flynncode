# Ollama Model Router — Design Spec

Date: 2026-09-14
Status: Draft
Location: `~/GitHub/opencode/ollama-model-router/`

## Problem

The user runs dozens of models across three Ollama providers (`ollama-local`,
`ollama-gpu`, `ollama-cloud`). Assigning the right model to the right kind of
work — best, cheapest, fastest — is manual and error-prone. Ollama Cloud does
not publish per-token prices, so an automatic price lookup is impossible;
rankings must be user-authored and validated.

## Goal

An opencode plugin that:

1. Lets the user assign each model a score for price, capability, and speed.
2. Ranks models per task type (coding, planning, review, lookup, writing,
   long-context) using per-task weights.
3. Automatically assigns the winning model to matching agents at startup.
4. Exposes manual override: a `/route` command, a `rank_models` tool, and a
   `route_task` tool that can execute the prompt on the winning model in a
   background child session.

Non-goals:

- No desktop UI panel (desktop catalog has no per-plugin settings editor;
  settings live in the plugin options tuple).
- No automatic price fetching or benchmarking. Price is a user-assigned
  relative score; real spend from the Ollama usage API is displayed as a
  calibration aid only.
- No mid-conversation model swapping via `chat.message`. Auto-routing happens
  once at config load by writing agent models.

## Architecture

Plugin directory referenced from the global config by absolute path:

```
~/GitHub/opencode/ollama-model-router/
  package.json          name, type: module, exports ./index.ts, engines.opencode
  index.ts              Plugin factory; wires config/chat hooks and tools
  src/scorecard.ts      Option parsing + validation; provider metadata fallback
  src/rank.ts           Pure scoring functions (no opencode imports)
  src/tools.ts          rank_models, route_task tool definitions
  tests/rank.test.ts    Unit tests for scoring
  tests/scorecard.test.ts  Unit tests for option parsing/validation
  docs/superpowers/specs/2026-09-14-ollama-model-router-design.md
```

The plugin export follows the v1 form required by opencode's loader:

```ts
export default {
  id: "ollama-model-router",
  server: (input: PluginInput, options?: PluginOptions) => Promise<Hooks>,
}
```

`id` is mandatory for path plugins (`resolvePluginId` throws otherwise).
Dependencies `@opencode-ai/plugin` and `zod` are resolved via the opencode
monorepo's `node_modules` (symlinked workspaces), so the plugin needs no
install step beyond being referenced in config.

## Configuration

Installed in `~/.config/opencode/opencode.jsonc` as a tuple entry:

```jsonc
"plugin": [
  // ...existing plugins...
  [
    "/home/yeager1977/GitHub/opencode/ollama-model-router",
    {
      "autoRoute": true,
      "allowUnscored": false,
      "providers": ["ollama-local", "ollama-gpu", "ollama-cloud"],
      "agentTasks": {
        "build": "coding",
        "plan": "planning",
        "explore": "lookup",
        "general": "coding"
      },
      "taskWeights": {
        "coding":       { "capability": 0.6, "price": 0.25, "speed": 0.15 },
        "planning":     { "capability": 0.7, "price": 0.2,  "speed": 0.1 },
        "review":       { "capability": 0.65, "price": 0.25, "speed": 0.1 },
        "lookup":       { "capability": 0.3, "price": 0.3,  "speed": 0.4 },
        "writing":      { "capability": 0.5, "price": 0.3,  "speed": 0.2 },
        "long-context": { "capability": 0.6, "price": 0.3,  "speed": 0.1 }
      },
      "models": {
        "ollama-cloud/glm-5.3-flash": {
          "price": 3, "capability": 8, "speed": 9,
          "tags": ["coding", "lookup", "long-context"]
        }
        // ...one entry per model the user wants ranked
      }
    }
  ]
]
```

Model IDs contain colons (e.g. `glm-5.3-flash:cloud`), so every model key is
quoted; the loader treats an unquoted `provider:model` string as an npm
specifier.

Rules:

- Model keys are `providerID/modelID` exactly as opencode reports them.
- `price`: 1–10, 10 = most expensive. Internally scored as `10 - price`.
- `capability`, `speed`: 1–10, 10 = best.
- `tags` (optional): restricts a model to listed task types. Untagged models
  are candidates for every task.
- Weights within a task need not sum to 1; the scorer normalizes.
- Models present in the configured providers but missing from `models` are
  "unscored": they are listed by `rank_models` as excluded (with provider
  metadata: context, parameter size, tool/reasoning flags) and are only
  eligible if `allowUnscored: true`, in which case they score with
  `capability: 5, price: 5, speed: 5`.
- `agentTasks` may include any agent name. Only non-hidden agents are touched.
  If an agent does not exist in the live config, the plugin logs a warning and
  skips it.

Defaults if omitted: `autoRoute: true`, `allowUnscored: false`,
`overrideExplicit: false`, providers = all providers whose id starts with
`ollama`, standard `agentTasks` and `taskWeights` as above, `models: {}`.

## Scoring

Pure function in `src/rank.ts`:

```
normalized weights: w' = w / (capability + price + speed)
score(model, task) = w'cap · capability
                   + w'price · (10 - price)
                   + w'speed · speed
```

Ranking is descending by score. Tie-break: cheaper (lower `price`), then faster
(higher `speed`), then lexicographic `providerID/modelID` for determinism.

Each result carries a human-readable reason list, e.g.
`["capability 8×0.60", "price rank 7×0.25 (−3 cost)", "speed 9×0.15", "tagged: coding"]`.

Candidates are filtered per task:

1. Provider is in the configured `providers` list.
2. Provider is not in the config's `disabled_providers` list. Note the user's
   current global config disables `ollama-local`; auto-routing still works
   because the `config` hook sees the merged provider definitions, but
   `rank_models` must mark such providers "disabled" so the exclusion is
   visible.
3. Model exists on that provider per the merged config's
   `cfg.provider[id].models`.
4. If the model has `tags`, the task must be in `tags`.
5. Unscored models are filtered unless `allowUnscored: true`.

## Hooks

### `config(cfg)`

Runs once after plugin load, before agents are materialized
(`Plugin` service is initialized before `Agent` in bootstrap). Behavior:

1. Parse and validate options; on invalid options, log a warning and disable
   routing (never throw — a thrown config hook is swallowed and would hide the
   error).
2. Resolve the live model list. Prefer `cfg.provider[id].models` from the
   merged config (available synchronously in this hook); this avoids a network
   call at startup. If empty, fall back to provider metadata embedded in the
   scorecard.
3. Rank every configured task type.
4. For each `agentTasks` entry, if `autoRoute` is true and the agent exists in
   `cfg.agent` or is a built-in (`build`, `plan`, `general`, `explore`),
   set `cfg.agent[name].model = "providerID/modelID"`.
   - Never overwrite an agent the user has explicitly marked with
     `"model"` in their own config unless the options include
     `"overrideExplicit": true` (default false).
   - Record assignments in module state for `rank_models`/`route_task`.
5. Never mutate `cfg.model` or `cfg.small_model`.

Note: `config` hooks receive the live merged config object; mutating
`cfg.agent[...].model` before the Agent service reads it is what makes
auto-routing effective. This was verified against opencode 1.18.31
(`packages/opencode/src/plugin/index.ts:247`, `config/config.ts:620`,
`agent/agent.ts:100`).

### `chat.message`

Not registered in v1. `UserMessage` has no metadata field to attach routing
reasons to, and live model mutation was explicitly scoped out. Deferred until
there is a persistence surface for routing hints (see Future work).

## Tools

### `rank_models`

Args: `{ task?: string, includeExcluded?: boolean }`.
Returns a formatted table: rank, model, score, price/capability/speed,
assigned agents, and exclusion reasons. With no `task`, returns the winner per
task type. Read-only.

### `route_task`

Args: `{ task: string, prompt: string, execute?: boolean, wait?: boolean }`.

- `execute: false` (default): returns the chosen model, score, reasons, and
  runner-up — no session created.
- `execute: true`: creates a child session of the caller's session via
  `client.session.create({ body: { parentID }, query: { directory } })`, then
  `client.session.promptAsync({ path: { id }, body: { model, agent: "general", parts: [{ type: "text", text: prompt }] } })`.
  Returns the child session ID immediately. If `wait: true`, uses the blocking
  `session.prompt` and returns the assistant text instead.
- The child session uses the same directory as the caller.
- A hard cap of one concurrent `route_task` execution per session prevents
  accidental fan-out; a second call while one is in flight returns an error
  explaining the cap.

`promptAsync` + subtask part vs child session: child session is used because
the task tool's background mode requires an experimental flag, while
`session.promptAsync` is stable and returns 204 immediately
(`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:311`).

## Command: `/route`

A custom command file installed at
`~/.config/opencode/command/route.md`:

```markdown
---
description: Route a task to the best-ranked Ollama model
---
Use the route_task tool with task "$1" and prompt "$ARGUMENTS" (strip the
leading task argument from the prompt), execute: true.
```

The plugin does not need `command.execute.before` for this: the command prompt
instructs the agent to call `route_task`, which owns model selection and child
session creation. This keeps all routing logic in one place and works with the
agent's normal permission flow.

The agent calls `route_task` through the normal tool-permission flow; no
`command.execute.before` hook is required in v1.

## Provider metadata fallback

`src/scorecard.ts` reads model metadata from two places, in order:

1. Live config providers (`cfg.provider`), which include `name`, `limit`,
   `tool_call`, `reasoning`, `attachment`, `variants`.
2. The user's scorecard `models` map (name, tags).

No network calls in the `config` hook. If a configured provider is unreachable
at runtime the plugin degrades to scorecard-only ranking; `rank_models` marks
the affected models "metadata unavailable".

## Ollama spend calibration (display only)

`rank_models` optionally appends real spend when the `ollama-cloud` provider
has an API key configured: `GET https://ollama.com/api/usage` with the
provider's `options.apiKey`, aggregated per model over the last 4 weeks, shown
as `$spent / requests` next to the scorecard price. Failures are silent; this
never blocks ranking. This is explicitly not used in scoring in v1.

## Error handling

- Invalid options or malformed scorecard: warn via the plugin's logger,
  routing disabled, tools still load and explain why (`rank_models` returns
  the validation errors).
- Missing model in provider list: excluded from ranking with reason
  `"not available on provider"`, surfaced in `rank_models`.
- `route_task` on an unknown task: returns the list of valid task names.
- All hooks are wrapped so an exception logs and continues; the plugin must
  never break opencode startup.

## Testing

Unit tests with `bun test` (no opencode runtime needed):

- `tests/rank.test.ts`: weight normalization; tag filtering; unscored
  handling; tie-break order; determinism; reason strings; excluded models.
- `tests/scorecard.test.ts`: option defaults; invalid score ranges; unknown
  provider handling; missing model handling; `allowUnscored` behavior.

Manual verification:

1. Start opencode with the plugin configured; confirm no startup errors and
   that `build`/`plan` agents resolve to the expected models (check logs or
   `rank_models` output).
2. Run `rank_models` with no args; verify winner-per-task table.
3. Run `/route lookup "What is the AC of chain mail?"`; verify child session
   spawns and uses the ranked model.
4. Temporarily set an invalid score; verify warning + disabled routing, and
   that opencode still starts.

## Verification performed for this spec

- Path plugins require a default-exported object with `id` and `server`
  (`packages/opencode/src/plugin/shared.ts:272,304`).
- Plugin options arrive as the factory's second argument
  (`packages/plugin/src/index.ts:51,68,74`).
- `config` hook runs after plugins load and before Agent state is built
  (`packages/opencode/src/plugin/index.ts:247`,
  `packages/opencode/src/project/bootstrap.ts:38`,
  `packages/opencode/src/agent/agent.ts:100`).
- `client.session.create` + `promptAsync` exist in the v1 SDK
  (`packages/sdk/js/src/gen/sdk.gen.ts:445,639`).
- Plugin tools are registered from `Hooks.tool` with Zod arg shapes
  (`packages/plugin/src/tool.ts:43`, `packages/opencode/src/tool/registry.ts:125`).
- Local directory plugins resolve `index.ts` with no compatibility gate
  (`packages/opencode/src/plugin/shared.ts:169-196`).

## Future work

- Real spend-aware scoring once price data is reliable.
- Per-session routing mode (`/route auto|manual`) persisted in session
  metadata.
- Benchmark harness writing measured speed/capability back into the scorecard.
