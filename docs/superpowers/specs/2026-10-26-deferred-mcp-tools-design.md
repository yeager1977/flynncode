# Deferred MCP Tools Design

Date: 2026-10-26
Status: implemented (spec synced with the implementation on 2026-10-26)

## Problem

Flynncode sends every enabled MCP tool's full definition to the model on every
provider turn. The owner has about 60 MCP tools enabled: `4m-mcp` exposes roughly
48 and `browsermcp` 13. Most of them go unused in most turns, which costs tokens
and latency, especially on the default `glm-5.3-flash` model.

Claude Code solves this with deferred tools: only tool names are listed up
front, and a ToolSearch tool loads full definitions on demand.

This is workstream 3 of 4 from the 2026-10-26 agent-parity gap analysis:
1. background shells (done);
2. Claude compatibility pack (done);
3. this spec;
4. hooks, scheduling and worktree tools.

## Decisions

- **Auto by count.** When more than `mcp_defer_threshold` visible MCP tools are enabled, MCP tools are deferred. The default threshold is 15. A server can opt out with `defer: false`, which always loads it fully. Below the threshold, behavior is unchanged.

## Design

### Deferral rule

Each provider turn:
- Take the MCP tools visible to the agent, after `Permission.disabled` hiding.
- If there are more than `experimental.mcp_defer_threshold` of them (default 15), defer every MCP tool, except:
  - tools of servers with `defer: false`;
  - tools already loaded in this session.
- `mcp.<server>.defer: true` always defers that server's tools, even below the threshold.
- Built-in tools are never deferred.
- Threshold `0` defers everything.
- `OPENCODE_DISABLE_MCP_DEFER=1` turns deferral off entirely.
- When the experimental code mode is on, deferral does nothing: code mode already hides MCP tools behind `execute`.
- When the agent is denied `tool_search`, deferral does nothing either: the agent could not load deferred tools, so they are all sent.
- MCP tools keep their existing order; deferral only filters. Request preparation already sorts tools, so a turn below the threshold sends exactly the request it sent before this feature.

### What the model sees

**System prompt block.** A deferred-tools block sits beside the existing `<mcp_instructions>`:
- It is grouped by server.
- It lists names only, sorted.
- It says to load tools with `tool_search` before calling them.

- It lists every deferral-eligible tool, loaded or not, so loading a tool does not change it.

It changes only when a server's tool list or the agent's permissions change, so it is cache-stable.

**`tool_search { query: string, max_results?: number }`** is present while deferral is active, even once every deferred tool has been loaded.
- `select:a,b` loads exact tool names. The prefix is case-insensitive, and at most 20 names are taken; the rest get a one-line note.
- Any other query is keyword search over names and descriptions, reusing code mode's scoring and tokenizer.
- `max_results` defaults to 5, maximum 20.
- It returns each matched tool's full description and parameter JSON schema.
- It adds the matched tools to the session's loaded set.
- Output is capped at about 25 KB (measured in bytes). Beyond that it returns names only with a "narrow your query" note; the matched tools are still loaded, since loaded tools are sent with their full schemas from the next step.
- A query with no match suggests the closest names.

**Loaded tools.** From the next provider step on, loaded tools are sent as normal tools in the existing alphabetical order. The model can call a tool in the same turn it searched for it.

### State

- The loaded set is stored in session metadata as `mcpLoaded: string[]` of tool ids.
- Every write reads the current metadata and merges, so it never clobbers other fields such as worktree or sandbox metadata.
- It survives compaction, reloads and app restarts.
- Each step sends only loaded ids that currently exist.
  - An id whose server is connected but no longer lists the tool is also removed from the stored set.
  - An id of a disconnected or failed server stays stored and comes back when the server reconnects.
- The loop reads the loaded set each step rather than once per run. It is the union of the stored set and the ids loaded by `tool_search` results in the session's messages since the last compaction. So a failed metadata write or read never loses a load mid-turn.
- A sub-agent session starts with an empty loaded set and sees the deferred list filtered by its own permissions. A forked session copies its parent's metadata, including the loaded set.

### Calls to tools that are not loaded

A call to a deferred tool that isn't loaded goes through the existing invalid-tool repair (`experimental_repairToolCall`). The model gets the result "Tool <id> is not loaded. Load it first with tool_search (query: "select:<id>"), then call it again."; no error is raised. The hint is given on the AI SDK path; the opt-in native LLM runtime does not give it yet.

### Permissions

`tool_search` lists and loads only tools the agent is already permitted to see. Calling a loaded tool asks permission exactly as before.

### App

- A `tool_search` call renders as a compact card, e.g. "Loaded 3 MCP tools: …".
- A query that loads nothing renders as "No MCP tools matched …".
- The "Deferred" badge on the MCP status view was not built: the server does not expose deferral state over the API.

## Error handling

- A disconnected or failing server's tools leave the list.
- A stale `select:` name returns "no such tool" for that name without failing the search.
- If building the deferred list fails, the turn falls back to sending all MCP tools.
- Metadata read and write failures are logged and never fail the turn; the loaded set still includes the run's `tool_search` results.

## Testing

All tests live in `packages/flynncode` and use a real local MCP test server (check existing MCP test fixtures), with no mocks.

1. **Threshold:**
   - 16 tools: deferred, and listed in the system prompt;
   - 15 tools: sent normally;
   - `defer: false` and `defer: true` override in each direction;
   - threshold `0` defers everything.
2. **`tool_search`:**
   - `select:` loads exact names;
   - keyword ranking;
   - the `max_results` cap;
   - no-match suggestions;
   - the output cap.
3. **Loaded tools:**
   - a loaded tool is sent on the next step and is callable in the same turn;
   - the loaded set survives a reload and compaction;
   - removed tools drop out.
4. **Permissions:** a denied tool is neither listed nor loadable; calling a loaded tool still asks.
5. **Sub-agents:** a sub-agent starts with an empty loaded set.
6. **Unloaded calls:** calling an unloaded deferred tool returns the "load it first" hint.
7. **Off switches:** code mode on means no deferral, and the env switch turns deferral off.
8. **App:** the `tool_search` card helper (browser suite).

## Out of scope

- Hooks, scheduling and worktree tools (own spec).
- Anthropic server-side tool search (`defer_loading`): a later optimization for Anthropic models.
- Deferring built-in tools.
