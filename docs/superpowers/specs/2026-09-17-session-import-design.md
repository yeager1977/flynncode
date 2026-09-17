# Session Import (Claude Code / Codex) - Design

Date: 2026-09-17
Status: Draft
Phase: 1 of 2 (see Scope)

## Problem

Flynncode has no way to bring an existing Claude Code or Codex conversation into
opencode. Users who have months of history in either tool start every opencode
session from zero, and there is no supported path to make that history visible as
a native opencode session.

Two constraints shape the solution:

1. **The desktop app has no runtime plugin UI API.** Server plugins are
   hooks-only (`tui?: never` at `packages/plugin/src/index.ts:79`). Only the TUI
   can host plugin-contributed UI, through `@opencode-ai/plugin/tui`
   (`route.register`, `ui.DialogSelect`, `slots.register`). The app's "plugins"
   screen only installs npm plugins into `opencode.json`.
2. **There is no public write path for arbitrary messages/parts.** The current
   server exposes `session.create` and `session.prompt`
   (`packages/protocol/src/groups/session.ts:129` and `:205`), but nothing that
   persists a message with parts. Session history is event-sourced: events
   published through `EventV2` are folded into tables by `SessionProjector`
   (`packages/core/src/session/projector.ts`).

The existing `opencode import <file>` command
(`packages/opencode/src/cli/cmd/import.ts:110-230`) writes directly into
`MessageTable`/`PartTable`. That only populates the **V1** projection. The app
timeline reads the **V2** `session_message` projection via the message protocol
group (`packages/protocol/src/groups/message.ts:26`), while the TUI reads the V1
`store.message` store from `session.messages`
(`packages/tui/src/context/sync.tsx:603`). Imported history must therefore reach
both projections to be visible everywhere.

## Goal

Let a user select one or more Claude Code or Codex sessions from a TUI interface
and import each one as a native opencode session in a chosen local project, with
user prompts and assistant text visible in both the TUI and the app timeline.

## Scope

In scope (phase 1):

- A TUI plugin that discovers, lists, filters, and multi-selects source sessions.
- A project picker defaulting to the current project.
- Claude Code `user` / `assistant` text and Codex `user_message` /
  `agent_message` / `response_item` message text.
- A core import service plus a protocol/server route that publishes events so
  both the V1 and V2 projections are written.
- Provenance metadata and skip-on-reimport dedupe.

Out of scope (deferred to phase 2 or later):

- Tool calls and tool outputs.
- Thinking/reasoning blocks.
- Sidechain / sub-agent transcripts.
- Images and file attachments.
- In-place update of an already-imported session.
- Desktop app UI. The server route is designed so a future app page can reuse it.
- External CLI sub-agents (Claude Code / Codex CLI as sub-agent backends). That
  is a separate sub-project with its own spec; it shares no implementation with
  this one.

## Architecture

Three components with a clean boundary at an HTTP endpoint.

```
TUI plugin (format-specific)          core + server (format-agnostic)
  discover files                        SessionImport service
  parse -> ImportedMessage[]     -->    publish SessionEvents
  render picker                         (V1 + V2 projections)
  call POST /api/import/session
```

### A. Core import service - `packages/core/src/session/import.ts`

A `SessionImport` service (module shape follows the `export * as` convention)
exposing one method:

```ts
import: (input: {
  sessionID: SessionSchema.ID
  transcript: ImportedMessage[]
}) => Effect.Effect<void, NotFoundError>
```

It publishes, per assistant turn, the existing `SessionEvent.Step.Started`,
`Text.Started` / `Text.Ended`, `Step.Ended` sequence, and per user turn
`SessionEvent.Prompted`. It also publishes the matching
`SessionV1.Event.MessageUpdated` / `PartUpdated` events. No new tables and no
schema migration. Usage accounting stays correct because imported turns carry
zero cost and zero tokens.

The service is format-agnostic: it knows only `ImportedMessage`.

### B. Protocol + server route - `packages/protocol/src/groups/import.ts`

`POST /api/import/session` with location middleware:

```
source: "claude-code" | "codex"
sourceSessionID: string
title: string
location: Location.Ref
transcript: ImportedMessage[]
```

The handler creates the session via the existing `SessionV2.create` (which
resolves or creates the project and computes `project_id` / `path` exactly like a
normal session, `packages/core/src/session.ts:207-236`), stamps provenance into
session metadata, then calls the import service.

`GET /api/import/imported` returns
`{ sourceSessionID, sessionID }[]` filtered by `source` and location, so the
plugin can mark already-imported sessions without paging every session.

Discovery stays out of core. Core must not hardcode `~/.claude` or `~/.codex`.

### C. TUI plugin - `packages/plugin/flynncode-session-import`

Owns everything format- and machine-specific:

- Locate `~/.claude/projects/**/*.jsonl` and
  `~/.codex/sessions/**/rollout-*.jsonl`.
- Parse both formats into `ImportedMessage[]`.
- Render the picker UI.
- Call the endpoint through `api.client`.

Keeps core free of vendor formats and makes the endpoint reusable by a future
app page.

Dependency direction follows `AGENTS.md`: Schema -> Core/Protocol -> Server. The
plugin depends only on the generated SDK.

## Data Model

Phase 1 transcript is deliberately minimal:

```ts
type ImportedMessage =
  | { role: "user"; text: string; time: number }
  | { role: "assistant"; text: string; time: number }
```

One text block per message. This maps onto:

- **V2**: `Prompted` (user); `Step.Started` + `Text.Started`/`Text.Ended` +
  `Step.Ended` (assistant), projecting to `SessionMessage.User` and
  `SessionMessage.Assistant` with a single `AssistantText` item.
- **V1**: `SessionV1.User` / `SessionV1.Assistant` messages with one
  `SessionV1.TextPart`.

### Provenance

Stored in `SessionTable.metadata` (free-form JSON column,
`packages/core/src/session/sql.ts:42`) under a reserved key:

```json
{ "import": { "source": "claude-code", "sourceSessionID": "...", "sourcePath": "...", "importedAt": 0 } }
```

No schema migration is needed. This is what dedupe queries.

## Format Mapping

### Claude Code

Source: `~/.claude/projects/<slug>/<uuid>.jsonl`, one JSON object per line.

Keep records where `type` is `user` or `assistant` and `isSidechain !== true`.
Read `message.content`: a string for `user`, a block array for `assistant`.
Concatenate `text` blocks in order into a single message, joined by a blank line;
ignore `tool_use`, `tool_result`, and `thinking` blocks in phase 1.

Skip `attachment`, `system`, `queue-operation`, `summary`,
`file-history-snapshot`, `last-prompt`, and `atis-latch` records. Skip
`isSidechain === true` records: those are sub-agent transcripts.

Title: the first user message truncated to a reasonable length, falling back to
the slug directory name.

### Codex

Source: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one JSON object per line.
Session ID and `cwd` come from the first `session_meta` record.

Two message sources, both used:

- `event_msg` with `payload.type == "user_message"` and
  `payload.type == "agent_message"` (`payload.message`), limited to final-phase
  agent messages.
- `response_item` with `payload.type == "message"` and `payload.role` in
  `user | assistant`. This layer also holds `reasoning`, `function_call`, and
  `function_call_output`, which are phase 2 concerns and are ignored here.

Assistant prose from both sources is deduplicated by normalized text, because
`event_msg.agent_message` mirrors `response_item.message` content. Without this
dedupe, assistant text appears twice.

## UX

Entry point: a TUI route named `session-import`, registered by the plugin, plus a
keymap command in the command palette.

Flow:

1. **Source** - `DialogSelect` between Claude Code and Codex.
2. **Project** - defaults to the current project. `client.project.list()` and
   `client.project.current()` populate a picker of recent projects.
3. **Sessions** - filterable multi-select (space toggles, enter imports).
   Each row shows title, relative time, message count, original cwd, and an
   `imported` marker. Already-imported rows are disabled by default, with a key
   to force re-import.
4. **Progress** - one line per session as it imports, then a summary dialog:
   `N imported, M skipped, K failed`, with per-failure reasons.

## Project Binding

`POST /api/import/session` passes `location.directory` (the picked project
directory) to `SessionV2.create`, which resolves or creates the project and
computes `project_id` and `path` like any other session. The source transcript's
original `cwd` is recorded in provenance metadata for reference only; it does not
decide placement.

## Dedupe

The plugin calls `GET /api/import/imported` before rendering the list and marks
matching source IDs. Skip is the default. Force re-import creates a second
session.

Events are append-only, so force re-import can never be an in-place update. That
is intentional and simpler, but it means "update an already-imported session" is
not in scope.

## Identity and Time

Message IDs are derived deterministically from source IDs where the format
provides one (Claude Code `uuid`), falling back to
`sha256(sourceSessionID + role + ordinal)`. This avoids random churn on
re-import for both formats. Codex records carry an `ordinal` field that is stable
within a rollout, so the fallback is deterministic there too.

Timestamps come from the transcript. `SessionTable.time_created` and
`time_updated` are set from the first and last imported timestamps so the session
sorts correctly in session lists.

## Errors

Per-session isolation:

- A malformed JSONL line is skipped and counted, not fatal.
- A missing or unreadable file fails that one session only.
- A failed endpoint call reports the reason and continues to the next session.
- The endpoint validates the transcript schema and rejects the whole request on
  invalid input rather than partially writing.

## Testing

- **Core**: projector-level test that importing a fixture transcript produces the
  expected `session_message` rows and the expected V1 `message` / `part` rows.
- **Parsers**: table-driven tests per format from small JSONL fixtures, covering
  sidechain exclusion, multi-block joining, Codex assistant dedupe, and malformed
  lines.
- **Endpoint**: create-then-import happy path, dedupe listing, invalid-transcript
  rejection.
- **Plugin**: selection and dedupe logic unit-tested; the UI itself stays thin.

Run from package directories, never the repo root. Use `bun typecheck` per
package.

## Open Questions

- Codex `event_msg.agent_message` carries a `phase` field. Phase 1 keeps final
  messages only; whether interim commentary should be imported is deferred to
  phase 2.

## Resolved Decisions

- Claude Code message records may omit a top-level `timestamp`. When absent, the
  parser inherits the timestamp of the nearest preceding record that has one, and
  falls back to the session's first timestamp. Ordering therefore follows file
  order, which is the transcript's own order.
- Both the V1 and V2 projections are written unconditionally. The TUI reads V1
  (`packages/tui/src/context/sync.tsx:603`) and the app timeline reads V2
  (`packages/protocol/src/groups/message.ts:26`), so writing only one would make
  imported history invisible in the other surface.
