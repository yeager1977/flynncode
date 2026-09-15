# Install

1. Reference the plugin directory from the global config (`~/.config/opencode/opencode.jsonc`):
   see the `plugin` array entry in the spec for the full options shape.
2. Restart opencode.
3. Verify with the `rank_models` tool or the logs (`agent routing:` line).
4. Optional: copy `~/.config/opencode/command/route.md` for the `/route` command.
5. Extend the `models` scorecard: every entry is `providerID/modelID` with
   `price`, `capability`, `speed` (1-10) and optional `tags`.
