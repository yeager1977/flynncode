# Ollama Model Router (built-in)

This plugin ships inside the opencode server bundle and loads by default. All
behavior is configured through the `model_router` key in the global config
(`~/.config/opencode/opencode.jsonc`):

```jsonc
"model_router": {
  "autoRoute": true,
  "allowUnscored": false,
  "providers": ["ollama-cloud", "ollama-gpu", "ollama-local"],
  "agentTasks": {
    "build": "coding",
    "plan": "planning",
    "explore": "lookup",
    "general": "coding"
  },
  "models": {
    "ollama-cloud/glm-5.3-flash": { "price": 3, "capability": 8, "speed": 9, "tags": ["coding"] }
  }
}
```

With no `model_router` key the plugin stays inert (no warnings, no routing).

- Verify routing with the `rank_models` tool or the `[ollama-model-router] agent routing:` log line.
- `/route <task> <prompt>` uses the `route_task` tool when the command file exists.
- Scorecard entries are `providerID/modelID` with `price`, `capability`,
  `speed` (1-10) and optional `tags`. See the design spec in
  `docs/superpowers/specs/2026-09-14-ollama-model-router-design.md`.
