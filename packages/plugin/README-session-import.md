# Session Import Plugin

Imports Claude Code and Codex conversation history into Flynncode as native
opencode sessions, from a TUI interface.

## What It Does

Discovers sessions on disk, lets you pick a source and a target local project,
and imports each selected session as its own opencode session with full
provenance metadata. Imported history is written to both the V2
`session_message` projection (the app timeline) and the V1 `message` / `part`
projection (the TUI), so it appears natively in both surfaces.

## Enable

The plugin must be loaded by the TUI plugin loader, which reads the module's
**default export** and requires it to expose `tui()` (see
`packages/opencode/src/plugin/shared.ts`, `readV1Plugin`). The
`@opencode-ai/plugin` npm package's `./tui` export resolves to the plugin types
module, which has no default export, and no `"tui-import"` options key is read
by the loader — so the plugin must be enabled as a **file-based local plugin**
pointing directly at `src/import/tui.tsx`.

Add the file spec to the `plugin` array in your TUI config. TUI plugins are
read from `tui.json` / `tui.jsonc` files (global config dir, `.opencode`
directories, or `OPENCODE_TUI_CONFIG`), not from `opencode.json`:

```jsonc
// <global config dir>/tui.json  (or <project>/.opencode/tui.json)
{
  "plugin": ["file:///absolute/path/to/packages/plugin/src/import/tui.tsx"]
}
```

Notes:

- Absolute paths work as well: `"/absolute/path/to/packages/plugin/src/import/tui.tsx"`.
- The path must point at the `.tsx` file itself. A directory spec resolves to
  its `index.ts`/`index.tsx`, and an npm spec for `@opencode-ai/plugin` would
  resolve the `./tui` export to `src/tui.ts` (the types module, which has no
  default export) — neither loads this plugin.
- The loader requires the default export to be `{ id, tui }`; the named export
  `ImportTuiPlugin` alone is not read.

## Use

Open the import flow from the command palette (**Import sessions**) or with the
default keybind:

| Action | Keybind |
| --- | --- |
| Open session import | `ctrl+shift+i` |

The command name is `session-import.open` and the route is `session-import`.

The flow is:

1. **Source** — choose Claude Code or Codex.
2. **Project** — the picker defaults to the current working directory and also
   lists projects returned by the server. The chosen directory becomes the new
   session's `directory` and determines its `project_id`, exactly as if the
   session had been created normally.
3. **Sessions** — a filterable multi-select. Enter on a row toggles it. Select
   the `Import N selected` row at the top and press Enter to run. Each row
   shows the title, message count, and original working directory.
   Already-imported sessions are shown but disabled.
4. **Progress** — a summary toast reports `Imported N, failed M`.
   A failure on one session does not stop the others.

## Source Directories

The plugin reads the standard on-disk locations for each tool:

| Source | Path |
| --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |

Claude Code sidechain records (sub-agent transcripts) are excluded. Codex
assistant text is read from `response_item` message records; user text is read
from `event_msg` user messages.

## What Phase 1 Imports

Imported sessions contain **user prompts and assistant text only**:

- No tool calls or tool outputs.
- No thinking / reasoning blocks.
- No sidechain or sub-agent transcripts.
- No images or file attachments.

Imported turns carry zero cost and zero tokens, so they do not affect usage
accounting.

## Re-import Behavior

Each import records provenance (source, source session ID, source path, and
timestamp) in the session metadata. When you open the import flow, sessions that
were already imported into the selected project are shown **disabled**.

Force re-importing an already-imported session creates a **new** session. It
never updates or overwrites the existing one. This is intentional: session
history is append-only and event-sourced, so an in-place update is not
supported.

## Scope

Phase 1 of the session import feature. Tool calls and thinking blocks are
deferred to phase 2. External Claude Code / Codex CLI sub-agent backends are a
separate, unrelated feature.
