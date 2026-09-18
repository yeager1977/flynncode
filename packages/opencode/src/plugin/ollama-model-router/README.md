# Ollama Model Router (built-in)

This plugin ships inside the opencode server bundle and loads by default. All
behavior is configured through the `model_router` key in the global config
(`~/.config/opencode/opencode.jsonc`):

```jsonc
"model_router": {
  "autoRoute": true,
  "allowUnscored": true,
  "providers": ["ollama-cloud", "ollama-gpu", "ollama-local"],
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
  "models": {
    "ollama-cloud/glm-5.3-flash": { "price": 3, "capability": 8, "speed": 9, "tags": ["coding"] }
  }
}
```

With no `model_router` key the plugin stays inert (no warnings, no routing).

- Every model on a configured provider is eligible by default
  (`allowUnscored: true`). Models without a scorecard entry score a neutral
  5/5/5. Set `allowUnscored: false` to require an explicit scorecard entry.
- `taskModels` pins a specific `providerID/modelID` per task. A pinned model is
  ranked first even when unscored or tagged away. A disabled provider still
  wins: the pin is ignored and the best-ranked eligible model is used instead.

- Verify routing with the `rank_models` tool or the `[ollama-model-router] agent routing:` log line.
- `/route <task> <prompt>` uses the `route_task` tool when the command file exists.
- Scorecard entries are `providerID/modelID` with `price`, `capability`,
  `speed` (1-10) and optional `tags`. See the design spec in
  `docs/superpowers/specs/2026-09-14-ollama-model-router-design.md`.
