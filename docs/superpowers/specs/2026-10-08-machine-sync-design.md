# Machine Sync (challenger ↔ starship) - Design

Date: 2026-10-08
Status: Approved in conversation, pending spec review

## Problem

Flynncode keeps chats in a per-machine SQLite database. Work started on one
machine (challenger) cannot be continued on another (starship), and settings
drift between them. The user wants both machines to show the same active chats
and the same configuration whenever both are on, while each stays fully usable
offline.

## Decisions (from user)

- **Model:** two-way sync. Each machine keeps its own full copy and can work
  offline; changes flow both ways when both are on.
- **Network:** same home LAN. No relay, no cloud, no tailnet requirement.
- **Paths:** projects live at identical paths on both machines (same user and
  layout), so a chat's `directory` is valid on both.
- **Conflicts:** newest wins, per whole chat.
- **Chat scope:** all non-archived chats with full history. Archived chats stay
  local; archive/unarchive/delete propagate.
- **Settings scope:** global config plus app preferences. Secrets and
  machine-specific state never sync.
- **Approach:** whole-chat snapshot sync over the existing LAN gateway, each
  side pulling from the other (approach A; row-level replication and DB-file
  copying were rejected).

## Architecture

Two Flynncode desktops, each running its usual sidecar (local opencode server
on loopback) and mobile gateway (LAN, port 4097). Sync adds:

1. **Sync routes on the gateway** under `/flynncode-sync/*`, authenticated only
   by a pairing token (constant-time compare). The phone password does not
   open them and the pairing token opens nothing else. The gateway forwards
   them to the local server.
2. **Sync endpoints on the server** (`packages/opencode`, Flynncode-owned),
   read-only from the peer's point of view: `manifest`, `session bundle`,
   `settings`. They are mounted only for gateway-forwarded sync requests.
3. **A sync worker in the server** that, every 60 s while paired and unpaused,
   pulls the peer's manifest, fetches newer bundles, and applies them to the
   local DB. Both machines run the same worker, so sync is two-way while each
   side only ever writes its own database.
4. **A Sync card** in Settings → Servers for pairing, status and control.

Peer address and pairing token live in the desktop settings store and reach
the sidecar in the `start` message (like relay settings), never in
`process.env` or config files, so they do not leak into agent shells.

## Pairing

- Machine A's Sync card shows a short pairing code (valid 10 minutes) and its
  LAN address.
- On machine B the user enters A's host (`starship.local` or an IP) and the
  code. B calls A's `/flynncode-sync/pair` with the code; A returns a fresh
  random 256-bit token and its machine name; both store
  `{ peerName, peerURL, token }`. A records B's URL from the request and B's
  name from the payload.
- Unpair on either side deletes the local record and revokes the token on the
  peer if reachable. One peer per machine (YAGNI on multi-peer).

## Chat sync

### Manifest

`GET /flynncode-sync/manifest` returns, for every non-archived session plus
tombstones from the last 30 days:

```
{ schema: <db schema version>, app: <version>,
  sessions: [{ id, parentID, timeUpdated, timeArchived?, busy }],
  tombstones: [{ id, timeDeleted }] }
```

Deletions write a row to a new `session_tombstone` table (id, time_deleted);
rows older than 30 days are pruned.

### Decision per chat

For each id in the peer manifest:

- Peer `timeUpdated` > local `timeUpdated` (or chat missing locally, or local
  copy archived earlier than the peer's newer state) → **pull**.
- Equal → keep local (tie rule).
- Local chat is running (legacy busy status or in the V2 `SessionExecution` active set) → skip this cycle.
- Peer reports the chat `busy` → skip this cycle (it is mid-turn there).
- Peer tombstone newer than the local `timeUpdated` → delete locally (and
  write a local tombstone).
- Peer chat archived and newer → archive locally (it then leaves the synced
  set).

Parents are applied before children (`parentID` order).

### Bundle

`GET /flynncode-sync/session/:id` returns everything that defines the chat:
the `session` row, `message` and `part` rows, `todo` rows, `session_folder`
rows, `session_input` rows, and `event` / `event_sequence` rows whose
`aggregate_id` is the session id. Owner claims (`event_sequence.owner_id`) are
cleared on export; ownership is process-local.

### Apply

One SQLite transaction per chat: delete the local chat's rows in the tables
above, insert the bundle's rows, ensure the project row exists via the normal
project lookup for `session.directory`. Any validation or insert failure rolls
back, leaving the local chat untouched, and is reported on the Sync card.

If `session.directory` does not exist on this machine the chat is still stored
and readable; the UI shows "folder missing on this machine" and the Sync card
counts it.

### First sync

Batches of 20 bundles per request cycle, progress shown on the Sync card; the
app stays usable.

## Settings sync

### Global config

`~/.config/opencode/opencode.jsonc` (or `.json`) syncs whole-file, newest
edit wins by file mtime (tie keeps local).

- **Never sent:** values at secret paths — any key matching
  `/(apiKey|api_key|token|secret|password)$/i` (suffix match, so `maxTokens` still syncs), any `headers` map value under
  `provider` or `mcp`, and `{env:…}`/`{file:…}` references — are replaced
  with a placeholder before sending. The `server` block is omitted.
- **On apply:** the local file is patched in place with the jsonc patch
  helpers (comments survive); local values at secret paths and the local
  `server` block are kept; placeholders never land in the file. A secret path
  present on the peer but absent locally is left absent.
- The result is validated with the normal config schema before writing; a
  failure skips the update and is reported.

### App preferences

The renderer's persisted `settings.v3` store sections `general`,
`appearance`, `keybinds`, `notifications` and `sounds` sync, newest wins,
with an updated-at stamp added to the store. Not synced: the `launch` store,
window state, open tabs, drafts, phone/relay/sync credentials.

## Sync card (Settings → Servers)

Shows: paired machine name, online/offline, last successful sync, chats
received/sent last cycle, folders missing here, first-sync progress, last
error. Controls: Pair (show code / enter host + code), Sync now, Pause,
Unpair. Styled with the v2 settings components; no titlebar UI. A toast
appears only when a manual Sync now fails.

## Error handling

- Peer unreachable: silent, card shows offline; polling backs off to every
  5 minutes after 5 consecutive failures, resets on success.
- Schema/app version mismatch: sync pauses with "Update Flynncode on both
  machines"; no partial apply.
- 401 from peer: card shows "Pair again".
- Per-chat apply failure: rolled back, listed on the card, retried next cycle.

## Limitations

- File snapshots used by undo/revert live outside the DB and do not sync;
  reverting a turn made on the other machine is not possible.
- Concurrent edits to the same chat on both machines while apart: the newer
  copy replaces the older one entirely (chosen behaviour).
- One peer per machine.

## Testing

- Unit: manifest diffing (newer/older/equal/missing/busy), tombstones,
  archive propagation, parent-before-child ordering.
- Transaction: a failing apply leaves the local chat byte-identical.
- Secrets: keys/tokens/auth headers never appear in the settings payload;
  local secrets survive an apply; comments survive.
- End to end: two opencode servers on two temp data dirs, paired, syncing
  both ways, including a conflict, a delete, an archive, and a running-chat
  skip.
