# Interactive terminal handoff

Date: 2026-09-23
Status: Approved approach, pending spec review

## Problem

The session terminal already accepts keystrokes and paste through a real PTY. The agent shell tool does not. It runs a command and returns text, so a password prompt or a bare Enter never reaches the user.

## Goal

When the agent runs a command that needs input, that command opens in the existing session terminal. The user types there, including passwords and Enter. A terminal the user opens themselves keeps working as it does today.

## Scope

In scope:

- Optional `interactive` flag on the shell tool.
- Automatic interactive handoff for commands whose first token is `sudo`, `ssh`, `su`, or `passwd`. Leading environment assignments (`FOO=bar sudo ...`) do not hide that token.
- Handoff creates a PTY using the same shell the shell tool already resolves. The PTY command is that shell. The args are the shell's login flag, when login semantics already apply, plus `-c` and the user command. Working directory is the shell tool `workdir`, or the session directory when `workdir` is omitted.
- Desktop opens the terminal panel and focuses that PTY when a shell tool result carries a `ptyID`.
- The tool waits for process exit or the existing shell timeout. A timeout does not kill the PTY. The tool result says the terminal is still open.
- Stdin is not copied into the tool transcript, logs, or metadata.
- Existing shell permission check still runs before the process starts.
- User-opened terminals are unchanged.
- New user-visible English strings use i18n keys. Terminal command text stays LTR. Panel layout uses the existing logical layout.

Out of scope:

- A chat password field.
- Running every shell command in the visible terminal.
- Detecting arbitrary prompts beyond the four commands above. The agent sets `interactive: true` for those.
- Clustering or cross-process PTY attach. Placement stays process-local.

## Architecture

Three existing pieces, no new terminal widget:

- `packages/opencode/src/tool/shell/prompt.ts` owns the parameter schema and a pure classifier, `needsInteractiveTerminal(command, interactive)`.
- `packages/opencode/src/tool/shell.ts` keeps the current non-interactive spawn. The interactive branch calls `Pty.create` with the command, records `ptyID` on tool metadata, and waits for `pty.exited` or timeout.
- `packages/app` session UI, on a shell tool part whose metadata includes `ptyID`, opens the terminal panel and selects that PTY. Keystrokes keep using the existing Ghostty writer and PTY websocket.

## Data flow

1. The model calls the shell tool with `command`, optional `timeout`, optional `workdir`, and optional `interactive`.
2. The tool asks the existing shell permission.
3. If `needsInteractiveTerminal` is false, the current spawn path runs and returns as it does today.
4. If true, `Pty.create` starts the shell in the workdir with the command. Tool metadata is `{ ptyID, interactive: true }` before waiting, so the desktop can focus the terminal while the command is still running.
5. The user types in the focused terminal. The PTY writes those bytes to the process. Programs that disable echo, such as `sudo`, do not put the password in the output buffer.
6. On exit, the tool returns the PTY output and exit code. On timeout, it returns the output so far and states that the terminal is still open. It does not call `Pty.remove`.

## Error handling

- PTY create failure fails the tool. The command is not reported as run.
- A missing or exited PTY while waiting fails the tool with the PTY error, not an empty success.
- Permission denial is unchanged.
- Timeout is not a failure of the tool call. The result text says the process is still running in the terminal.

## Testing

- Unit-test `needsInteractiveTerminal`: `sudo id` and `FOO=1 ssh host` are interactive. `ls`, `git status`, and `echo sudo` are not. An explicit `interactive: true` is interactive even for `ls`. An explicit `interactive: false` stays non-interactive even for `sudo`.
- Shell tool test: the interactive branch records a PTY id in metadata and does not attach a stdin log field. A non-interactive call does not create a PTY.
- Desktop: a shell tool part with `ptyID` opens the terminal panel and selects that id. No new keystroke path.

## RTL

Terminal contents stay `dir="ltr"`. Any new panel chrome uses logical properties and the existing terminal panel. No new physical left/right layout.
