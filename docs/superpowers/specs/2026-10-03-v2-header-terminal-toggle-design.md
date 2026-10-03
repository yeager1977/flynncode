# V2 Session Header Terminal Toggle

Date: 2026-10-03

## Problem

On the new (V2) layout — the default since version >= 1.17.19/2.0.0 upgrades and the
hard default after the old-interface sunset — the session header
(`SessionHeaderV2Actions` in `packages/app/src/components/session/session-header.tsx`)
renders status, review, tasks, and handoff buttons but **no terminal toggle button**.
The terminal toggle button only exists in the legacy fallback branch of the header.

As a result, in the desktop app there is no visible, discoverable way to open the
terminal panel. The command still works via `ctrl+\`` and the `/terminal` slash
command, and the panel auto-opens when the agent runs an interactive shell command
(sudo, ssh, su, passwd, or `interactive: true`), but nothing on screen advertises
the terminal or lets the user open it deliberately.

## Goal

Give the V2 header the same terminal affordance the legacy header has: a visible
toggle button that opens a fully interactive terminal panel docked on the side,
with pressed-state styling, tooltip, keybind, and correct ARIA wiring.

## Design

One component, `packages/app/src/components/session/session-header.tsx`:

1. **Extend `SessionHeaderV2ActionsState`** with:
   - `terminalLabel: string` — `language.t("command.terminal.toggle")`
   - `terminalKeybind: string[]` — `command.keybindParts("terminal.toggle")`
   - `terminalOpened: boolean` — `view().terminal.opened()`
   - `onTerminalToggle: () => void` — the existing `toggleTerminal` handler
     (toggles the panel, focuses the active terminal after opening)

2. **Add a terminal button to `SessionHeaderV2Actions`**, before the review button:
   - `IconButtonV2`, variant `ghost-muted`, size `large`, class `!w-9 shrink-0`
     (identical to review/tasks buttons)
   - `state={terminalOpened ? "pressed" : undefined}`
   - `icon={<Icon name="terminal-open" />}` (name chosen from existing icon set;
     if `terminal-open` does not exist, reuse the review pattern's icon component
     `Icon` size via `IconV2` — final name picked at implementation by checking
     `packages/ui` icon exports)
   - `aria-label`, `aria-expanded={terminalOpened}`,
     `aria-controls="terminal-panel"`
   - Wrapped in `TooltipV2` showing `terminalLabel` + `KeybindV2` when a keybind
     exists — the exact pattern used for the review button

3. **i18n**: no new keys; `command.terminal.toggle` exists in all locales.

## Non-goals

- No layout changes (panel placement, resizing, stacking stay as-is)
- No change to auto-open behavior on interactive commands
- No left/right placement switch, no detachable OS window

## Error handling

None needed. The toggle handler already exists and is guarded:
`focusTerminalById` returns `false` silently if the terminal is not mounted.

## Testing

- `bun typecheck` from `packages/app`
- Existing terminal e2e specs keep passing: `terminal-hidden.spec.ts`,
  `terminal-tab-switch.spec.ts` (button presence/behavior)
- Manual verification in the desktop app: button visible in header, opens the
  side panel, accepts keyboard input, pressed state tracks open/closed