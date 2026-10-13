# Flynncode self-based builds + naming — design

Date: 2026-10-13
Status: approved by user (verbal: "implement it")

## Problem

The desktop app ("OpenCode Dev", deb `opencode-dev`, version
`1.18.34~dev~202610031719`) ships a bundled server binary
`resources/opencode-cli` that is byte-identical to the pinned **upstream**
`@opencode-ai/cli 0.0.0-next-16350`, fetched by
`packages/desktop/scripts/{predev,prebuild}.ts` via `downloadCliToResources()`.
That upstream binary predates Flynncode's `permission.sandbox` policy schema
(commits `f0e244f44e`, `a83d34aeea`), so the installed app rejects the user's
fork-written config (`~/.config/opencode/opencode.jsonc`,
`~/.config/flynncode/opencode.jsonc`) with:

```
ConfigInvalidError: permission.sandbox — Expected PermissionActionConfig, got "full-access"
```

Meanwhile the fork-built CLI (`packages/flynncode/dist/opencode-linux-x64/bin/opencode`,
today's build `1.18.34-dev-202610131923`) decodes the same config cleanly.
Root cause: every packaged build of this fork ships a server that was not
built from this code.

## Goal

All shipped artifacts are built from this repo. User-visible naming is
`flynncode`. The only remaining connection to upstream opencode is the git
remote used to review and pull in changes.

## Non-goals

- No internal identifier renames: `@opencode/*` service tags, `OPENCODE_*`
  env/defines, `opencode-web-ui.gen.ts`, session DB filename, state dir
  (`~/.local/share/opencode/`), `~/.config/flynncode/` layout.
- No icon/branding artwork changes.
- No behavior changes to core, server, or the app beyond naming/packaging.

## Decisions (user-approved)

1. Depth: packaging + app identity + full user-visible CLI renaming; internals untouched.
2. App id: full identity swap — fresh Electron profile accepted (window pins/layout reset);
   old `opencode`/`opencode-dev` debs removed after installing the replacement.
3. Compiled binary renamed to `flynncode` with `flynncode-*` dist paths.

## Design

### 1. Build pipeline — the desktop ships our server

- `packages/desktop/scripts/predev.ts` and `prebuild.ts` no longer call
  `downloadCliToResources()`. Delete `downloadCliToResources()`,
  `CLI_BINARIES`, and `CLI_VERSION` from `scripts/utils.ts`.
- `prebuild.ts` builds the fork CLI for the host platform
  (`bun script/build.ts --single` in `packages/flynncode`), then copies
  `packages/flynncode/dist/flynncode-<os>-<arch>/bin/flynncode` to
  `packages/desktop/resources/flynncode-cli` (mode 755). It fails fast with a
  clear error if the dist binary is missing, instead of silently shipping a
  stale or foreign binary.
- `packages/desktop/src/main/background-cli.ts` `executableName()` returns
  `flynncode-cli` (`flynncode-cli.exe` on Windows).
- `electron-builder.config.ts`: `files` exclusion and `extraResources` filter
  switch from `opencode-cli*` to `flynncode-cli*`.

### 2. App identity & packaging

| channel | appId | productName | deb/rpm package |
| --- | --- | --- | --- |
| dev | `ai.flynncode.desktop.dev` | Flynncode Dev | `flynncode-dev` |
| beta | `ai.flynncode.desktop.beta` | Flynncode Beta | `flynncode-beta` |
| prod | `ai.flynncode.desktop` | Flynncode | `flynncode` |

- `artifactName`: `flynncode-desktop-${os}-${arch}.${ext}`.
- Metainfo/desktop-entry resources renamed to the new app ids; upstream
  legacy-compat entries (hidden `opencode-desktop.desktop`, upstream
  bugtracker/homepage/screenshot URLs) are dropped or re-pointed at
  `yeager1977/flynncode`.
- `copy-metainfo.ts`, `copy-icons.ts` channel arguments, and
  `electron-builder.config.test.ts` updated to the new identities.
- Icons unchanged.
- Rollout on this machine: package `flynncode-dev` deb, verify contents
  (SHA + `full-access` schema strings + renderer bundle hashes), install with
  `sudo dpkg -i`, then remove the old `opencode` and `opencode-dev` packages.

### 3. CLI binary naming

- `packages/flynncode/script/build.ts`: `artifactPrefix` `"opencode"` to
  `"flynncode"`; outputs `dist/flynncode-<os>-<arch>/bin/flynncode`; bun
  `execArgv` user-agent becomes `flynncode/<version>`; tarballs become
  `flynncode-*.tar.gz`.
- Update references to `dist/opencode-*` / `bin/opencode` in
  `packages/flynncode/script/publish.ts` and any other script/test.
- `publish.ts` release targets (AUR, Homebrew, GitHub release URLs) point at
  the fork origin (`yeager1977/flynncode`), so an accidental run can never
  publish into or reference the upstream project.

### 4. Upstream relationship

- `upstream = anomalyco/opencode` git remote stays as-is; nothing else in the
  repo may vendor upstream binaries or releases.
- Add a short section to root `AGENTS.md`: builds and publishing are
  fork-only; the one supported way to take upstream work is
  `git fetch upstream` plus targeted merges.

### 5. Verification

- `packages/desktop`: `bun test` (config identity tests), `bun typecheck`.
- `packages/flynncode`: `bun typecheck`; local `script/build.ts` run
  producing `dist/flynncode-linux-x64/bin/flynncode`, with
  `flynncode --version` check.
- On this machine: deb content verify (bundled `flynncode-cli` SHA matches
  the dist binary; `full-access` present; no upstream `@opencode-ai/cli`
  strings), install, remove legacy packages, and smoke-test that the app
  starts with the existing `~/.config/flynncode/opencode.jsonc`
  (`permission.sandbox: "full-access"` accepted — the original bug is gone).
