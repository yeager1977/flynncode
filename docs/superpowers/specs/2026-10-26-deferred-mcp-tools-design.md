# Deferred MCP Tools Design

Date: 2026-10-26
Status: approved design, pending implementation plan

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

### What the model sees

**System prompt block.** A deferred-tools block sits beside the existing `<mcp_instructions>`:
- It is grouped by server.
- It lists names only, sorted.
- It says to load tools with `tool_search` before calling them.

It changes only when a server's tool list or the agent's permissions change, so it is cache-stable.

**`tool_search { query: string, max_results?: number }`** is present only while some tool is deferred.
- `select:a,b` loads exact tool names.
- Any other query is keyword search over names and descriptions, reusing code mode's scoring and tokenizer.
- `max_results` defaults to 5, maximum 20.
- It returns each matched tool's full description and parameter JSON schema.
- It adds the matched tools to the session's loaded set.
- Output is capped at about 25 KB. Beyond that it returns names only with a "narrow your query" note.
- A query with no match suggests the closest names.

**Loaded tools.** From the next provider step on, loaded tools are sent as normal tools in the existing alphabetical order. The model can call a tool in the same turn it searched for it.

### State

- The loaded set is stored in session metadata as `mcpLoaded: string[]` of tool ids.
- Every write reads the current metadata and merges, so it never clobbers other fields such as worktree or sandbox metadata.
- It survives compaction, reloads and app restarts.
- Ids that no longer exist (a server changed its list or disconnected) are dropped on the next turn.
- The loop reads the loaded set each step rather than once per run.
- A sub-agent session starts with an empty loaded set and sees the deferred list filtered by its own permissions.

### Calls to tools that are not loaded

A call to a deferred tool that isn't loaded goes through the existing invalid-tool repair (`experimental_repairToolCall`). The model gets a result telling it to load the tool with `tool_search` first; no error is raised.

### Permissions

`tool_search` lists and loads only tools the agent is already permitted to see. Calling a loaded tool asks permission exactly as before.

### App

- A `tool_search` call renders as a compact card, e.g. "Loaded 3 MCP tools: …".
- The MCP status view shows a "Deferred" badge on servers whose tools are currently deferred, if the app already has an MCP status surface; otherwise this is skipped.

## Error handling

- A disconnected or failing server's tools leave the list.
- A stale `select:` name returns "no such tool" for that name without failing the search.
- If building the deferred list fails, the turn falls back to sending all MCP tools.
- Metadata merge failures are logged, and the turn proceeds with the in-memory loaded set.

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
