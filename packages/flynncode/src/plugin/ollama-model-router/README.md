# Ollama Model Router (built-in)

This plugin ships inside the opencode server bundle and loads by default. All
behavior is configured through the `model_router` key in the global config
(`~/.config/opencode/opencode.jsonc`):

```jsonc
"model_router": {
  "enabled": true,
  "autoRoute": true,
  "allowUnscored": false,
  "legacyAssign": false,
  "providers": ["ollama-cloud", "anthropic", "openai", "xai"],
  "agentTasks": {
    "build": "coding",
    "plan": "planning",
    "explore": "lookup",
    "general": "coding"
  },
  // Pin a model to a task. Beats scoring, tags, and scorecard entries.
  "taskModels": {
    "review": "ollama-cloud/deepseek-v4-pro"
  },
  // Models hidden in the app's Manage Models screen, written live.
  "excludeModels": ["ollama-cloud/gemma4:31b"],
  "models": {
    "ollama-cloud/glm-5.3-flash": { "price": 3, "capability": 8, "speed": 9, "tags": ["coding"] }
  }
}
```

With no `model_router` key the plugin stays inert (no warnings, no routing).

- `enabled` (default true) is the master switch. `false` keeps the scorecard
  but does not inject Model Router, rewrite prompts, or rank models. A prompt
  that still selects Model Router while routing is off (or its options are
  invalid) fails with an error instead of reaching a provider.
- `agentTasks` entries merge over the defaults (`build`/`general` → coding,
  `plan` → planning, `explore` → lookup). Agents with no entry route as
  `coding` and log a warning.
- Agentic xAI Grok models ship with bundled scorecard entries. A user entry
  for the same key replaces the bundled one wholesale. Non-agentic Grok
  models (`grok-imagine-*`, `grok-4.20-multi-agent-0309`) are always excluded;
  a user `excludeModels` list is unioned with those defaults.
- Every model on a configured provider is eligible by default
  (`allowUnscored: true`). Models without a scorecard entry score a neutral
  5/5/5. Set `allowUnscored: false` to require an explicit scorecard entry.
- `taskModels` pins a specific `providerID/modelID` per task. A pinned model is
  ranked first even when unscored or tagged away. A disabled provider or an
  `excludeModels` entry still wins: the pin is ignored and the best-ranked
  eligible model is used instead.
- The router keeps its model list live: it refetches the connected catalog
  when a provider connects or disconnects (`integration.connection.updated`)
  or models.dev refreshes (`models-dev.refreshed`), and revalidates at most
  every 5 minutes otherwise. Silent external changes (e.g. `opencode auth
  login` in another process, pulled models) usually surface within that
  window, but two 5-minute TTLs run in series — the server's own
  provider-state cache and this plugin's catalog cache — so in the worst case
  (this plugin's refetch landing just before the server-side TTL expires) a
  silent change can take up to roughly 10 minutes to surface.
- `excludeModels` lists `providerID/modelID` pairs the router must skip. Manage
  Models visibility writes it into the config live (explicit hides only), and
  the router settings editor passes the server's current list through on Save.
- The router injects a virtual `model-router/auto` provider shown as **Model
  Router** in the model picker. Selecting it routes each prompt to the winning
  concrete model (per the active agent's task, or the selected task variant);
  the transcript records the concrete model while the session keeps the
  sentinel. Selecting any concrete model bypasses routing entirely.
- `legacyAssign` (default false) restores the old behavior of rewriting agent
  models at startup. Prefer selecting Model Router in the picker.
- `architecture` is a task with quality-first weights, used to reserve premium
  models for complex design work. `taskModels` pins win over scoring.

- Verify routing with the `rank_models` tool or the `[ollama-model-router] agent routing:` log line.
- `/route <task> <prompt>` uses the `route_task` tool when the command file exists.
- Scorecard entries are `providerID/modelID` with `price`, `capability`,
  `speed` (1-10) and optional `tags`. See the design spec in
  `docs/superpowers/specs/2026-09-14-ollama-model-router-design.md`.
