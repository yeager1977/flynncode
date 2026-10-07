# Muse-to-opencode Auth Sync - Design

Date: 2026-10-06
Status: Approved (pending implementation plan)

## Problem

opencode's `meta` provider authenticates with a pasted API key, while the
Muse subscription lives in the `muse` CLI's own OAuth session
(`~/.config/muse/auth.json`, `mechanism: oauth`, `obtained_via:
device_code`). Manually copying the auto-connected subscription `api_key`
into opencode's `auth.json` works but is manual and error-prone; an expired
or lapsed key fails later, inside a session.

## Decisions (from user)

- Trigger: **on-demand command** (not automatic, not scheduled). A fully
  automatic refresh is impossible anyway: an expired muse session needs
  interactive browser approval.
- Form: **standalone script** on PATH, independent of any repo checkout.
- Logged-out case: **offer to launch `muse login`**, not just print a
  reminder.
- Internals: **copy + verify** (not copy-only).

## Script contract

- Path: `~/.local/bin/muse-opencode-auth`, executable, Python 3 stdlib
  only.
- No arguments for a standard run; `--check` for verify-only mode (reports
  whether the keys match and whether opencode's key is live; changes
  nothing).
- Exit `0` on success or already-in-sync; non-zero with a plain message
  otherwise.
- Secret hygiene: the key is never printed and never passed as a CLI
  argument (file-to-file transfer inside Python). Backups are
  `auth.json.bak-<timestamp>` with original file permissions preserved.

## Sync flow

1. Read `providers.meta.api_key` from `~/.config/muse/auth.json`. Absent
   → logged-out flow.
2. Compare with opencode `auth.json` `meta.key`. Identical → verify
   liveness (step 4) and report "already in sync".
3. Differ → back up opencode `auth.json`, replace the `meta` entry with
   `{"type": "api", "key": ...}`, preserving all other providers.
4. Verify: `GET https://api.meta.ai/v1/models` with the new key; expect
   HTTP 200. Success → report key length + prefix only (e.g. `LLM|…`).
   Failure → restore the backup automatically, then logged-out flow.

## Logged-out / verify-fail flow

- Print that no usable Muse credential exists (or the fresh key failed)
  and ask whether to launch `muse login` now [Y/n].
- On yes: run `muse login` in the foreground, wait for it, re-read the
  credential, resume at sync-flow step 2. On no: exit non-zero with the
  reminder.
- One login offer per run. If verification fails after a fresh login
  (e.g. lapsed subscription), say so explicitly instead of looping.

## Out of scope

- Scheduled/background sync (user chose on-demand).
- An opencode-native OAuth login for Meta (Meta publishes no third-party
  OAuth client; see the warning-gate spec's Subscription auth section).
- Syncing the OAuth `access_token` itself — opencode's meta provider
  consumes only the API key.
- Repo-hosted script (user chose standalone on PATH).
