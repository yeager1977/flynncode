# Desktop Session Import UI - Design

Date: 2026-09-17
Status: Draft
Depends on: `2026-09-17-session-import-design.md` (phase 1: core service, routes, TUI plugin)

## Problem

Phase 1 shipped session import with a TUI plugin as the only interface. The
desktop app cannot host TUI plugins: the TUI plugin host
(`createLegacyTuiPluginHost`) exists only in the CLI
(`packages/opencode/src/cli/cmd/tui.ts:272`, `attach.ts:132`), and the packaged
desktop `app.asar` contains no reference to it. The desktop app therefore has no
UI to trigger the import that already exists on the server.

Compounding this, the desktop renderer cannot discover sessions at all. It is
sandboxed (`packages/desktop/src/main/windows.ts:201-203`: `contextIsolation:
true`, `nodeIntegration: false`, `sandbox: true`), it has no IPC for walking
arbitrary directories, and the server's filesystem routes are
project-location-scoped and die on paths outside the workspace
(`packages/core/src/filesystem.ts:66-73`, `Path escapes the location`).
`~/.claude/projects` and `~/.codex/sessions` are therefore unreachable from the
renderer by any existing path.

## Goal

Let a user import Claude Code and Codex sessions from the desktop app's Settings,
selecting multiple sessions and a target project, with the same fidelity and
dedupe behaviour as the TUI flow.

## Scope

In scope:

- Move the pure transcript parsers and discovery into `@opencode-ai/core`.
- Add server-side discovery and server-side import routes.
- A desktop-only Settings section with source toggle, project picker,
  searchable multi-select, disabled already-imported rows, per-session
  progress, and a summary toast.
- Tests for the moved core code, the new routes, and the app's pure selection
  logic.
- Rebuild the `.deb` and refresh `~/Downloads` after the code lands.

Out of scope:

- Import UIs on other platforms, or for other source tools.
- A combined-session import mode, and a force-reimport control.
- Refactoring the existing TUI plugin onto the new routes.
- Tool calls, thinking blocks, sidechains, and attachments (phase 2 of the
  original import feature).
- In-place update of an already-imported session.

## Architecture

Three components, with the filesystem boundary moved to the server.

```
app Settings section                server (has filesystem access)
  GET  import.sources        -->    discover() over ~/.claude, ~/.codex
  POST import.fromSource     -->    re-read + parse + importSession
```

### A. Core discovery and parsing - `packages/core/src/session/import-source/`

`types.ts`, `claude-code.ts`, and `codex.ts` move **verbatim** from
`packages/plugin/src/import/`. They are pure: no plugin API, no TUI, and only
`JSON.parse` and `node:path`. The move is a relocation, not a rewrite, so their
existing tests move with them unchanged.

`discover.ts` moves and gains a real-filesystem adapter. The existing `discover`
takes injected `read` and `list` callbacks, which keeps it testable; the adapter
supplies real implementations using core's filesystem layer rooted at
`Global.Path.home` (`packages/core/src/global.ts:19`, which already honours
`OPENCODE_TEST_HOME`).

`importSession` in `packages/core/src/session/import.ts` is reused **unchanged**.
No import logic is duplicated: `from-source` resolves a file into a transcript
and then calls the same operation the transcript-body route calls.

### B. Protocol and server routes

Two endpoints join the existing `server.import` group in
`packages/protocol/src/groups/import.ts`:

- `GET /api/import/sources?source=<claude-code|codex>&directory=<abs>`
  returns candidates: `path`, `sourceSessionID`, `title`, `cwd`, `time`,
  `messageCount`, `imported`.
- `POST /api/import/from-source`
  payload `{ source, sourceSessionID, sourcePath, title, location }`; the server
  reads the file, parses it, and imports it. Returns the created `Session.Info`.

The existing `import.session` endpoint (transcript in the body) is unchanged, so
the TUI plugin keeps working untouched.

The handler must bind its services at group level, matching
`packages/server/src/handlers/session.ts:21`. A handler that leaks its
requirements breaks the embedded `sdk-next` build; this was a real failure
during phase 1, fixed in commit `ec3e7a0e19`.

### C. App UI - `packages/app/src/components/settings-v2/`

A new desktop-gated section, following the plugins tab precedent
(`dialog-settings-v2.tsx:71-76` for the trigger, `:128-132` for the content,
both gated on `platform.platform === "desktop"`).

- `import-sessions.tsx` - the section: source toggle, target directory picker,
  searchable multi-select list, Import action, per-session progress.
- `import-selection.ts` - pure selection and ordering helpers, unit-tested.

It calls `sdk().client.v2.import.sources(...)` and `.fromSource(...)`. Both are
already generated (`packages/sdk/js/src/v2/gen/sdk.gen.ts:5881`).

## Filesystem Boundary Exception

The new routes read outside the project location on purpose. This is the
feature: they read the user's home-directory tool stores, not project files.
This is a deliberate and contained exception:

- The project-location sandbox for every other filesystem route is unchanged.
- The exception is confined to the two `server.import` endpoints.
- Discovery never accepts a caller-supplied path to walk. It accepts a `source`
  enum, and the server derives the root itself
  (`~/.claude/projects` or `~/.codex/sessions` under `Global.Path.home`).
- `from-source` accepts a `sourcePath`, which the server re-validates by
  re-running discovery and confirming the path is one of the discovered
  candidates. A path that is not a discovered candidate is rejected.

That last point matters: without it, `from-source` would be an
arbitrary-file-read endpoint. Validation is by membership in the candidate set
for the requested source, not by trusting the string.

## Data Flow

1. The Settings section resolves a target directory: the currently open
   project directory by default, with a picker listing known project
   directories.
2. It requests `import.sources` for the chosen source and directory.
3. The server discovers and parses candidates, and marks each as `imported` by
   consulting `SessionImportRegistry.findImported` for that directory.
4. The user selects rows. Already-imported rows are disabled.
5. For each selected session the client issues `POST import.from-source`,
   sequentially, so a slow import cannot reorder progress.
6. The server re-reads and parses the file, then calls
   `SessionImport.importSession`, which stamps provenance and writes both the V2
   and V1 projections.
7. The client counts successes and failures and shows one summary toast.

Re-reading the file at import time keeps the request small and avoids acting on
a client-supplied transcript. The cost is a race: if the file changes or
vanishes between listing and import, that one session fails and the batch
continues.

## Error Handling

- **Per-session isolation.** A missing or unreadable file, a parse that yields no
  messages, or a failed import increments a failure count and does not abort the
  remaining sessions.
- **Missing source directory.** Absent `~/.claude` or `~/.codex` yields an empty
  candidate list, not an error. The UI shows an empty state.
- **Malformed JSONL lines** are skipped by the parsers, which never throw.
- **Typed route errors.** `InvalidRequestError` for an unknown source or a
  non-candidate path. `SessionNotFoundError` only where a session must exist.
- **Empty selection** disables the Import action rather than erroring.
- **Duplicate import.** Already-imported sessions are disabled in the list, which
  is the only dedupe guarantee. The server does not re-check provenance on
  import: `SessionImport.importSession` has no dedupe today
  (`packages/core/src/session/import.ts`), and `findImported` is consulted only
  when listing sources. A caller that posts `from-source` for an
  already-imported session will create a second session. The UI prevents this by
  disabling those rows; the route does not enforce it. Enforcing it server-side
  is deferred, and the spec records it as a known gap rather than claiming a
  guarantee the code does not provide.

## Testing

- **Core**: the moved parser tests run unchanged; new tests cover the
  real-filesystem discovery adapter using `OPENCODE_TEST_HOME` pointed at a
  fixture home, including the missing-directory and nested-date-directory cases.
- **Protocol**: a route-surface test for the two new endpoints.
- **Server**: a handler test importing a fixture transcript through
  `from-source`, asserting the session was created, provenance persisted, and
  both projections were written. Plus a test that a non-candidate path is
  rejected.
- **App**: pure selection and ordering helpers unit-tested (toggle, disabled
  imported rows, counts). The dialog itself stays thin and has no runtime test;
  this gap is stated rather than hidden.

Run from package directories, never the repo root. Use `bun typecheck` per
package. The full `bun turbo typecheck` must pass, because the pre-push hook
runs it.

## Accepted Costs

- **Duplication.** Discovery and parsing will exist twice: in core, and in
  `packages/plugin/src/import/`. The plugin is deliberately left untouched so
  the working TUI flow carries no risk. This is recorded debt; if the copies
  drift, the two UIs will disagree about what is importable.
- **Sandbox exception.** The new routes read outside the project location, as
  described above.
- **No runtime UI test.** The app section is typechecked and its pure logic is
  tested, but the rendered flow is not.

## Verification

Verified after implementation:

- `bun turbo typecheck` passes (31/31), including `packages/sdk-next`.
- Core, protocol, server, and app tests for this feature pass.
- A live check: start a server, list sources, import one through `from-source`,
  and read the history back through `GET /api/session/:id/message` to confirm the
  imported messages are present.
- The `.deb` is rebuilt and copied to `~/Downloads` with a matching checksum.

Not verified:

- The rendered Settings section in a running desktop app. The implementer should
  open the app and confirm the tab, list, selection, and toast once; if that is
  not possible, it must be reported as unverified rather than assumed.
