# Meta Contributor Model Warning Gate - Design

Date: 2026-10-05
Status: Approved (pending implementation plan)

## Problem

Meta offers Muse Spark 1.3 Contributor (and 1.2 Contributor) at discounted
pricing in exchange for permission to use prompts and generated completions to
train future Meta models. The model is not configured as a repo default, and
nothing warns the user that starting a chat with it — or switching to it —
shares their content and context with Meta.

## Decisions (from user)

- The models surface through the **meta provider** (models.dev catalog; the
  user already has a Meta API key in auth.json).
- Warning trigger: **once per session** — fires when a chat starts with a
  Contributor model or the model is switched to mid-session; no re-warn on
  every prompt within the same session.
- Warning form: **blocking dialog** in the **desktop app only**. TUI gets a
  log line only; no dialog.
- Scope: **both** muse-spark-1.2-contributor and muse-spark-1.3-contributor
  (identical data-sharing terms).
- Model config ships as a **repo default**, not a user-config edit.

## Model availability

The model metadata already exists in the models.dev catalog
(`meta/muse-spark-1.2-contributor`, `meta/muse-spark-1.3-contributor`; 1M
context, tool_call, reasoning, $0.10/$0.20 per Mtok, multimodal input). No new
model metadata is authored.

The repo default config (the default-seeding path in
`packages/opencode/src/config/config.ts`, alongside the existing
`model_router` defaults) gains a `meta` provider entry:

- `npm: "@ai-sdk/openai"` (matches models.dev `meta.api.npm`)
- `baseURL: "https://api.meta.ai/v1"` (matches models.dev `meta.api`)
- models: `muse-spark-1.2-contributor`, `muse-spark-1.3-contributor`

Auth uses the existing Meta API key flow (`META_MODEL_API_KEY` / auth.json
`meta` entry, which the user already has).

## Subscription auth (reuse CLI credential)

Research (2026-10-06, dev.meta.ai/docs): Meta publishes no third-party
OAuth client — the only documented third-party auth is an API key (Bearer
token against `https://api.meta.ai/v1`). The Muse Code subscription
credential is auto-connected during the `muse` CLI onboarding and is stated
to be for use with Muse Code only. A one-click "log in with Muse
subscription" button in opencode is therefore not buildable from public
information.

Decision: reuse the CLI credential. After completing `muse` onboarding
(browser sign-in, `/login`), copy the stored subscription credential from
the Muse CLI's local storage into opencode as the `meta` provider API key
(connect-provider dialog, or `META_MODEL_API_KEY` env). No auth-plugin code
changes; the plan gains a verification step that locates the stored
credential (no `muse` CLI exists on this machine, so the exact path is
confirmed at implementation time).

Caveats, stated plainly:

- Meta's docs say the subscription credential is for use with Muse Code
  only; reusing it in opencode may violate Meta's terms. The user accepts
  this risk.
- MMA (Meta Managed Account) users cannot use browser sign-in at all and
  must use an API key.
- An explicit `META_API_KEY`/`META_MODEL_API_KEY` env var takes priority
  over any stored session; an env key can silently hide the subscription
  credential.

The router is untouched: neither Contributor model gets a scorecard entry, so
with `allowUnscored: false` the Model Router never routes to it. Meta is not
added to `model_router.providers` defaults.

## Warning detector (shared module)

New module `packages/app/src/utils/contributor-models.ts`:

- Static ID set: `meta/muse-spark-1.2-contributor`,
  `meta/muse-spark-1.3-contributor`.
- `isContributorModel(providerID: string, modelID: string): boolean`.
- `confirmContributorModel(...): Promise<boolean>` — the dialog gate helper.
  It takes a callback that renders the dialog (injected at the session page
  level, same wiring pattern as `useUsageExceededDialogs()` at
  `packages/app/src/pages/session.tsx:2102`) and resolves `true` on Continue,
  `false` on Cancel. The `LocalProvider` sits under `DialogProvider` in the
  app tree, so the injected accessor avoids restructuring the provider.

Warning copy lives in i18n keys `dialog.metaContributor.title`,
`.description`, `.continueLabel`, `.cancelLabel` — English only in `en.ts`
initially. The description states plainly that prompts and generated content
sent with this model are shared with Meta and may be used to train future Meta
models. No hardcoded English strings in component code (app localization
rules).

## Blocking dialog component

New `packages/app/src/components/dialog-meta-contributor.tsx`, modeled on
`dialog-usage-exceeded.tsx`: a `Dialog` with title/description and two
buttons.

- **Cancel** (ghost): aborts the selection or send.
- **Continue** (primary): records the ack and proceeds.
- No "don't show again" button — the warning is once per session by design,
  not once ever.

## Model-selection gate

Choke point: `local.model.set` in
`packages/app/src/context/local.tsx` (the same `ModelSelection.set` path is
re-exported by `prompt-model-selection.ts`, so both selection code paths are
covered).

- When `isContributorModel` matches the incoming key and the target scope has
  no recorded ack, the dialog is shown before the change commits.
- Cancel: selection unchanged (none of the `write`/visibility/recent effects
  run).
- Continue: ack recorded for the scope, then the model change applies
  normally.
- Scope for the ack: the persisted model-selection state already keys by
  session (`saved.session[sessionID]`, draft scope for new sessions). The ack
  is stored alongside it in the same persisted store shape used by
  `usage-exceeded-dialogs.tsx` (`Persist.*` targets), keyed by session ID when
  one exists; draft/new-session selections ack only at send time (below).

## Submit gate

Choke point: `createPromptSubmit.handleSubmit` in
`packages/app/src/components/prompt-input/submit.ts`, immediately after
`currentModel` is resolved (~line 339) and before any session creation, input
clearing, or network send.

- If the resolved model is a Contributor model and the target session has no
  ack: `await` `confirmContributorModel(...)`.
  - Cancel → return without sending. Safe: the prompt has not been cleared
    yet (`clearInput()` happens later), so nothing needs restoring.
  - Continue → record the ack, proceed with the send.
- Fresh sessions (no ID yet) always see the dialog at first send — there is no
  session ID to ack against until the session is created; after creation the
  ack is recorded under the new session ID.
- "Once per session" is satisfied for the "return to a session the next day"
  case structurally: a returning session has an ack only if that session
  already went through the gate. Session-scoped ack means re-opening the same
  session does not re-warn; a different session does.

Queued prompts (`shouldQueue`/`onQueue`) and shell/custom-command sends flow
through the same `handleSubmit` before their respective branches, so the gate
covers them at queue/commit time. Followup drafts sent outside
`handleSubmit` (`sendFollowupDraft` called directly) are also gated — the ack
check rides on the session ID at the call sites that send.

## Exclusions (not gated)

- `small_model` and subagent/task-tool model choices: never dialogs; they are
  not user-visible selections in the session composer.
- TUI: no dialog; a log line when a Contributor model starts a session
  (desktop-only warning per user decision).
- Model Router: Contributor models are ineligible (no scorecard card), so no
  routed prompt can silently use one.

## Error handling

- If the dialog helper's injected accessor is missing (non-app contexts, e.g.
  unit tests or a future TUI host), `confirmContributorModel` fails closed:
  it blocks the selection/send unless the caller opts out explicitly. This
  keeps desktop behavior safe and lets non-UI contexts resolve the helper as
  a no-op only when intentionally configured.
- Persisted ack state corruption degrades to "not acked" (warn again), never
  to silently skipping the warning.

## Testing

- Unit: `isContributorModel` matches both IDs and rejects lookalikes
  (`muse-spark-1.3`, `muse-spark-1.3-contributor-free`, other providers).
- Unit: gate logic — selection blocked/allowed by ack state; submit gate
  aborts before any send on Cancel and records ack on Continue; queued sends
  gated.
- App component test: dialog renders i18n keys (English), Cancel/Continue
  wiring.
- Config: repo default config exposes the meta provider and both models;
  `bun run ./src/index.ts models` (from `packages/opencode`) lists both
  Contributor models when a Meta key is available.
- Browser/manual: select the model in the picker → dialog appears → Cancel
  keeps the old model; Continue applies it and later prompts in the same
  session do not re-warn; switching away and back mid-session does not
  re-warn (ack is session-model-agnostic and recorded once); a new session
  with the same model warns again at first send.

## Out of scope

- TUI dialogs.
- Warning on every prompt (not per user decision).
- Config-driven warning policy (future data-sharing models are added by
  extending the static list in code).
- Router integration for Contributor models.
- "First launch ever" acknowledgment or persistent badge while the model is
  active.