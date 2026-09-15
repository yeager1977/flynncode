# Implementation Plan — Composer Accept-All Toggle + Model Router Settings Editor

Specs:
- `docs/superpowers/specs/2026-09-15-composer-accept-all-toggle-design.md`
- `docs/superpowers/specs/2026-09-15-model-router-settings-editor-design.md`

## Global Constraints

- Follow existing file style; no new code comments except where the file already
  comments densely (config.ts, plugin sources). UI files: no comments.
- Reuse existing UI primitives (`@opencode-ai/ui/v2/*`); no new IPC.
- Plugin public behavior (routing, tools) must not change.
- New i18n keys must satisfy `packages/app/src/i18n/parity.test.ts`.
- Tests run from `packages/app` or `packages/opencode`, never repo root.
- Commits: `git -c user.name="Chris Flynn" -c user.email="chrisflynn1977@gmail.com"`.
  Do not push.
- App single-file test command:
  `cd packages/opencode`/`packages/app` then
  `bun test --conditions=solid --preload ./happydom.ts ./src/<path>` (app).

## Task 1 — server: model_router subtree replace (DONE)

Commit `668c71510f`. `patchJsonc` treats top-level `model_router` as a leaf;
plain-JSON branch overrides after mergeDeep. Fixtures under
`packages/opencode/test/config/fixtures/v2-compat/update-global/`.
Tests: `bun test test/config/` from `packages/opencode` → 232 pass.

## Task 2 — payload module (packages/app)

Goal: pure form ↔ config conversion + validation, mirroring the plugin rules.

Files:
- `packages/app/src/components/settings-v2/model-router-payload.ts` (new)
- `packages/app/src/components/settings-v2/model-router-payload.test.ts` (new)

Types (must match plugin `types.ts`/`scorecard.ts`):
- TaskName: coding | planning | review | lookup | writing | long-context
- ScoreEntry: { price: number; capability: number; speed: number; tags?: TaskName[] }
- Form state: autoRoute, allowUnscored, providers: string[], agentTasks: {agent,task}[],
  taskWeights: Record<TaskName,{capability,price,speed}>, models: {key,tags,price,capability,speed}[]

Functions:
- `DEFAULT_AGENT_TASKS`, `DEFAULT_TASK_WEIGHTS`, `TASK_NAMES` (copy values from
  `packages/opencode/src/plugin/ollama-model-router/scorecard.ts`).
- `emptyForm()`
- `formFromConfig(config: Record<string, unknown> | undefined)` — normalize; absent → defaults.
- `serializeForm(form)` — returns config object; omit `models` when empty; always include autoRoute.
- `validateForm(form)` — returns `{ ok: true; value } | { ok: false; errors: string[] }`:
  - model key must contain `/` with non-empty sides
  - scores integer 1..10
  - task names valid
  - duplicate model keys rejected
  - agent name non-empty

Tests (bun:test): round-trip empty; formFromConfig with partial config; serialize omits
empty models; validation failures for bad key/score/task/dupes; defaults preserved.

Commit: `feat(app): add model router payload module`

## Task 3 — Model Router settings tab

Files:
- `packages/app/src/components/settings-v2/model-router.tsx` (new)
- `packages/app/src/components/settings-v2/dialog-settings-v2.tsx` (add trigger + content)
- reuse `model-router-payload.ts`

Behavior:
- `usePlatform()`; only render tab when desktop (same gate as plugins: wrap with
  `<Show when={platform.platform === "desktop"}>`).
- Read current config: `useServerSync().data.config?.model_router` → `formFromConfig`.
- Local `createStore` form state; footer Save (validateForm → `serverSync().updateConfig({ model_router: value })`,
  success toast + "applies on restart" description) and Discard (reset from config).
- Sections per spec: General (2 switches), Providers (chips + SelectV2 from
  `useProviders().connected()`), Agents (rows + agent select from `serverSync().data.agent`
  filtered `mode !== "subagent"`, task select from TASK_NAMES), Task weights
  (6 rows × 3 TextInputV2 numeric), Scorecard (rows with key, tags, 3 numeric inputs;
  Add opens Dialog with searchable model picker from `useModels().list()`, values
  `providerID/modelID`; delete with confirm Dialog).
- Use `SettingsRowV2`/`SettingsListV2` and settings-v2 classes; `showToast` from `@/utils/toast`.
- Add i18n key references now (Task 6 adds the strings; use the exact keys listed there).

Commit: `feat(app): add model router settings editor`

## Task 4 — composer Accept-All toggle

Files:
- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/components/prompt-input-v2.tsx`
- `packages/session-ui/src/v2/components/prompt-input/index.tsx` (add `acceptAllControl` prop)
- `packages/app/src/pages/session.tsx` (pass control into both composers)
- `packages/app/src/components/permission-toggle-target.ts` (new pure helper) + test

Helper:
```ts
export function permissionToggleTarget(sessionID: string | undefined): "session" | "directory" {
  return sessionID ? "session" : "directory"
}
```

Classic composer: in the toolbar controls row after the variant control, add
`<div data-component="prompt-accept-all-control">` with an `IconButtonV2`
(`variant="ghost-muted"`, `state={accepting() ? "pressed" : undefined}`,
`aria-pressed`, `aria-label`, tooltip via `TooltipV2` with keybind) that calls:
- session: `permission.toggleAutoAccept(id, sdk().directory)`
- none: `permission.toggleAutoAcceptDirectory(sdk().directory)`
Icon: classic `Icon name="checklist"` (import from `@opencode-ai/ui/icon`).
`accepting()` memo already exists in the file.

V2: add `acceptAllControl?: JSX.Element` to `PromptInputV2Props`, render after the
variant control in the toolbar; pass from `prompt-input-v2.tsx` composer using the
same handler (permission context already available there).

session.tsx: build the control element once and pass to both `PromptInput` (via a new
`acceptAllControl` prop on PromptInputProps) and `PromptInputV2Composer`.

Tests: helper test; plus permission precedence additions:
- cross-directory isolation (two dirs in one autoAccept record)
- toggling off an inherited true writes explicit session false (unit test the pure
  `autoRespondsPermission` semantics with such a record).
Add to `packages/app/src/context/permission-auto-respond.test.ts`.

Commit: `feat(app): add accept-all toggle to the composer`

## Task 5 — settings become default-only

Files:
- `packages/app/src/components/settings-general.tsx`
- `packages/app/src/components/settings-v2/general-controllers.ts`
- `packages/app/src/components/settings-v2/general.tsx`
- tests in `packages/app/src/components/settings-v2/`

Change: both settings switches read `isAutoAcceptingDirectory(dir)` and write
`toggleAutoAcceptDirectory(dir)`; directory from `useServerSDK().directory` (classic)
/ active directory (v2). Add pure `createDirectoryPermissionController(directory)`
behavior in `general-controller-behavior.ts` if not context-bound; keep the existing
session controller only for the settings dialog's sessionID flow if still needed —
grep first; if unused after the change, remove it.

Tests: pure function tests for the directory controller behavior.

Commit: `refactor(app): permissions settings edit the project default only`

## Task 6 — i18n

Files: `packages/app/src/i18n/en.ts` + all locales listed in
`packages/app/src/i18n/parity.test.ts`.

New keys (en values):
- `settings.tab.modelRouter`: "Model Router"
- `settings.modelRouter.title`: "Model Router"
- `settings.modelRouter.description`: "Route agents to the best Ollama model for each kind of task."
- `settings.modelRouter.autoRoute.title`: "Auto-route agents"
- `settings.modelRouter.autoRoute.description`: "Assign the top-ranked model to each agent at startup."
- `settings.modelRouter.allowUnscored.title`: "Allow unscored models"
- `settings.modelRouter.allowUnscored.description`: "Include models without a scorecard entry, scored 5/5/5."
- `settings.modelRouter.providers.title`: "Providers"
- `settings.modelRouter.providers.description`: "Providers considered for routing."
- `settings.modelRouter.agents.title`: "Agent tasks"
- `settings.modelRouter.agents.description`: "Which task type each agent is routed for."
- `settings.modelRouter.weights.title`: "Task weights"
- `settings.modelRouter.weights.description`: "Relative importance of capability, price, and speed per task."
- `settings.modelRouter.scorecard.title`: "Scorecard"
- `settings.modelRouter.scorecard.description`: "Per-model scores from 1 to 10. Price 10 is most expensive."
- `settings.modelRouter.scorecard.add`: "Add model"
- `settings.modelRouter.scorecard.remove`: "Remove model"
- `settings.modelRouter.scorecard.empty`: "No models scored yet."
- `settings.modelRouter.save`: "Save"
- `settings.modelRouter.saved`: "Model router saved"
- `settings.modelRouter.appliesOnRestart`: "Routing applies after restart."
- `settings.modelRouter.invalid`: "Fix the highlighted values before saving."
- `settings.modelRouter.add.title`: "Add model"
- `settings.modelRouter.add.description`: "Pick a model to score."
- `settings.modelRouter.remove.title`: "Remove model"
- `settings.modelRouter.remove.description`: "Remove {{model}} from the scorecard?"
- `settings.modelRouter.model`: "Model"
- `settings.modelRouter.capability`: "Capability"
- `settings.modelRouter.price`: "Price"
- `settings.modelRouter.speed`: "Speed"
- `settings.modelRouter.tags`: "Tags"
- `settings.modelRouter.providers.add`: "Add provider"
- `settings.modelRouter.agents.add`: "Add agent"
- `common.discard`: "Discard" (check existing first; reuse if present)

Parity: check `script/translate-app.ts` / package scripts for the translation
pipeline. If translation requires an external service, satisfy parity by adding the
same keys with English values to each locale file (acceptable; parity only requires
key presence + identical placeholders). Verify with:
`cd packages/app && bun test --conditions=solid --preload ./happydom.ts ./src/i18n/parity.test.ts`

Composer toggle strings: reuse existing (`command.permissions.autoaccept.enable/disable`,
`toast.permissions.autoaccept.on/off.*`). Add only:
- `command.permissions.sessionOverride`: "Override for this session"
- `command.permissions.projectDefault`: "Accept all for this project"

Commit: `feat(app): add model router and permission toggle strings`

## Task 7 — build and verify

- `cd packages/app && bun run typecheck`
- `cd packages/opencode && bun run typecheck && bun test test/plugin/ollama-model-router test/config`
- `cd packages/app && bun run test:unit`
- `cd packages/desktop && OPENCODE_CHANNEL=dev bun run build`
- Verify router markers in `out/main/chunks/*.js`, then
  `npx electron-builder --linux deb --publish never --config electron-builder.config.ts`
- Copy deb to ~/Downloads with a descriptive name; report sha256.

Commit: `chore(desktop): build dev deb with router editor and accept-all toggle`
(no source changes expected; skip commit if no diff)
