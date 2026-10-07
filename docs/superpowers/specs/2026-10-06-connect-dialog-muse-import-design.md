# Connect-Dialog Muse Import - Design

Date: 2026-10-06
Status: Approved (pending implementation plan)

## Problem

Using the Muse subscription in opencode requires running the standalone
`muse-opencode-auth` script by hand. The provider connect/reconnect dialog
for `meta` only offers pasting an API key. The import should be one click
from the dialog.

## Decisions (from user)

- **Meta only.** No generic CLI-import mechanism.
- **Missing CLI / logged out:** hide or disable the action (no login
  launching from the dialog).
- **Wiring:** renderer button + narrow IPC channel (not a server-side auth
  method).

## Detection (main process)

- New IPC `muse-auth-status`: main checks `muse` on PATH and reads
  `~/.config/muse/auth.json` for `providers.meta.api_key` presence.
- Returns `{ installed: boolean, loggedIn: boolean }`. No secret ever
  crosses IPC.
- The dialog queries it when opened for provider `meta`. The import action
  is visible and enabled only when `installed && loggedIn`; otherwise the
  dialog is unchanged (paste-key flow). When installed but logged out, a
  hint line tells the user to run `muse login`.

## Sync IPC contract

- New IPC `muse-auth-sync`: main locates `muse-opencode-auth`
  (`~/.local/bin` first, then PATH), runs it via `execFile` with a
  timeout, captures stdout/stderr + exit code.
- Returns `{ ok: boolean, output: string }`. Secrets are already redacted
  by the script (length + prefix only).
- No credential crosses IPC in either direction: the script reads/writes
  the auth files directly.
- Server pickup of the rewritten `auth.json` uses its existing reload
  path; the plan confirms whether an explicit refresh call is needed and
  adds one if not.

## Dialog UI

- In `DialogConnectProvider` (`packages/app/src/components/dialog-connect-provider.tsx`)
  for `provider === "meta"`: an "Import from Muse CLI" action beside the
  paste-key method.
- Click → pending state → success closes the dialog with a toast; failure
  shows the script's message inline with retry.
- All copy via i18n keys (English in `en.ts` initially; follow the
  fallback-module convention per the parity test).
- Reconnect reuses the same dialog, so connect and reconnect are covered
  by construction.

## Scope / exclusions

- Desktop app only. Web and TUI keep the paste-key flow untouched.
- No server or protocol changes; no new auth-method type.
- Preload bridge gains exactly two invokes (`muse-auth-status`,
  `muse-auth-sync`). Main validates inputs: fixed script-path resolution
  only, no arbitrary command execution.

## Out of scope

- Generic per-provider CLI import.
- Launching `muse login` from the dialog.
- Scheduling or automatic background sync.
