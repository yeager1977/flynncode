# Composer Permission Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the effective chat permission state obvious with a labeled on/off switch in both composer layouts.

**Architecture:** Reuse the V2 Switch and the existing effective permission accessors and callbacks. Supply a stable translated label through the V2 view configuration and directly in the classic composer.

**Tech Stack:** SolidJS, Kobalte, TypeScript, Bun, Vite, Playwright.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-16-composer-permission-switch-design.md`.
- Use the existing translated `command.permissions.autoaccept.enable` label.
- Preserve chat-lineage override > project-default permission precedence.
- Keep `data-action="prompt-accept-all"`, the scope-aware tooltip, and the shortcut.
- Use the shared switch's keyboard, focus, and RTL behavior.
- Run checks from package directories and benchmarks serially against production builds.
- Preserve unrelated workspace changes. Do not restart the running app or server.
- This is a reversible presentation-only change: use existing tests and browser verification.

---

### Task 1: Replace the icon-only permission control and verify both layouts

**Files:**
- Modify: `packages/app/src/components/prompt-input.tsx`
- Modify: `packages/app/src/components/prompt-input-v2.tsx`
- Modify: `packages/session-ui/src/v2/components/prompt-input/index.tsx`
- Existing checks: `packages/app/src/context/permission-auto-respond.test.ts`
- Existing checks: `packages/app/src/components/prompt-input/submit.test.ts`

**Interfaces:**
- Consumes: `accepting(): boolean`, `view.acceptAll.active(): boolean`, `view.acceptAll.onToggle(): void`.
- Produces: the existing V2 `Switch` with `checked` bound to effective state; `view.acceptAll.label()` returns the stable visible label.

- [ ] **Step 1: Record the production benchmark baseline.**

From `packages/app`, using an unused test port:

```sh
PLAYWRIGHT_PORT=4456 SESSION_TAB_SWITCH_RUNS=2 bunx playwright test --config e2e/performance/playwright.config.ts timeline/session-tab-switch-benchmark.spec.ts --grep "benchmarks v2 session tab switching"
```

Record cold/hot first-correct and stable timing summaries; report any baseline
environment blocker accurately rather than treating it as a regression.

- [ ] **Step 2: Replace the classic icon control.**

Remove the unused `Switch` import from `solid-js` and the now-unused
`IconButtonV2` import; import `Switch` from `@opencode-ai/ui/v2/switch-v2`.
Inside the existing tooltip use:

```tsx
<Switch
  class="shrink-0"
  checked={accepting()}
  data-action="prompt-accept-all"
  style={control()}
  onChange={() => {
    const id = props.controls.session.id
    if (id) {
      permission.toggleAutoAccept(id, sdk().directory)
      return
    }
    permission.toggleAutoAcceptDirectory(sdk().directory)
    restoreFocus()
  }}
>
  {language.t("command.permissions.autoaccept.enable")}
</Switch>
```

- [ ] **Step 3: Replace the V2 icon control.**

In the app wrapper, set:

```tsx
label: () => language.t("command.permissions.autoaccept.enable"),
```

In the session-ui composer, import `Switch` from
`@opencode-ai/ui/v2/switch-v2` and replace only the permission button with:

```tsx
<Switch
  class="h-7 shrink-0"
  checked={control.active()}
  data-action="prompt-accept-all"
  onChange={control.onToggle}
>
  {control.label()}
</Switch>
```

- [ ] **Step 4: Run existing checks and package typechecks.**

From `packages/app`:

```sh
bun test --conditions=solid --preload ./happydom.ts ./src/context/permission-auto-respond.test.ts ./src/components/prompt-input/submit.test.ts
bun typecheck
```

From `packages/session-ui`:

```sh
bun typecheck
```

- [ ] **Step 5: Verify the actual composer controls in the browser.**

Use `agent-browser` with isolated browser state and fixture sessions. Confirm the
visible label and checked state in both layouts; click label/track, press Space,
and use the existing shortcut. Check inherited-on and explicit-off behavior,
light/dark themes, narrow width, English LTR/forced RTL, and Arabic RTL. Inspect
track fill and thumb position as well as accessible state. Use existing localized
copy for Arabic rather than creating translations. Adjust only composer layout
classes if the wider control needs wrapping.

- [ ] **Step 6: Repeat the same production benchmark and review the diff.**

Compare with Step 1 without machine-dependent thresholds. Run `git diff --check`
and inspect only the intended source and documentation changes. Summarize the
actual verified results and any environment limitations.
