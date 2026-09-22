# Oh My OpenCode Allowlist Models - Design

Date: 2026-09-21
Status: Draft

## Problem

The Oh My OpenCode installer wrote `~/.omo/omo.jsonc` with stock chains that
prefer OpenAI (`gpt-5.6-luna-fast`, `gpt-5.6-sol`, `gpt-5.6-terra`) and omit
Ollama Cloud. The user's allowlist is `ollama-cloud`, `anthropic`, `openai`,
and `xai`. Defaults must be sensible members of that list, **Claude over
ChatGPT**, and **must not use xAI**.

## Goal

Rewrite `[opencode].agents` and `[opencode].categories` in
`~/.omo/omo.jsonc` so every primary model is Anthropic or Ollama Cloud.
OpenAI may appear only as a fallback. xAI keys must not appear in this file
after the edit. Do not change Flynncode source. Do not vendor OMO.

## Scope

In scope:

- Edit `~/.omo/omo.jsonc` only (this machine).
- Keep existing agent and category keys the installer created.
- Preserve JSONC comments and `$schema`.
- Restart reminder after the edit.

Out of scope:

- Changing OMO's built-in fallback chains in the plugin package.
- Re-enabling the Flynncode model router.
- Adding xAI, Gemini, or Copilot entries.
- UI work (artifacts, routines, dispatch, mobile).

## Provider policy

- **Primary:** `anthropic/*` for quality roles; `ollama-cloud/*` for cheap
  or high-volume roles.
- **Fallback:** `openai/*` only, and only where a second rung is useful.
- **Forbidden in this file:** any `xai/` key.

## Mapping

Use these exact ids. `variant` / `reasoning` stay as in the table.

### Agents

| Agent | Primary | Variant | Fallback |
|---|---|---|---|
| sisyphus | `anthropic/claude-opus-5` | max | `ollama-cloud/glm-5.3` |
| hephaestus | `anthropic/claude-opus-5` | medium | `ollama-cloud/glm-5.3` |
| oracle | `anthropic/claude-opus-5` | max | `openai/gpt-5.6-sol` xhigh |
| librarian | `ollama-cloud/glm-5.3-flash` | | `anthropic/claude-haiku-4-5` |
| explore | `ollama-cloud/glm-5.3-flash` | | `anthropic/claude-haiku-4-5` |
| multimodal-looker | `anthropic/claude-sonnet-4-6` | low | `ollama-cloud/glm-5.3-flash` |
| prometheus | `anthropic/claude-opus-5` | high | |
| metis | `anthropic/claude-opus-5` | high | |
| momus | `anthropic/claude-opus-5` | high | `openai/gpt-5.6-sol` xhigh |
| atlas | `anthropic/claude-sonnet-4-6` | | `ollama-cloud/glm-5.3` |
| sisyphus-junior | `anthropic/claude-sonnet-4-6` | | `ollama-cloud/glm-5.3` |

If an installer key is missing, skip it. Do not invent new agent names.

`claude-sonnet-5` in the current file is replaced by `claude-sonnet-4-6`,
which is the id already scored in the user's model router config.
`claude-fable-5` primaries become `claude-opus-5`.

### Categories

| Category | Primary | Variant | Fallback |
|---|---|---|---|
| visual-engineering | `anthropic/claude-opus-5` | max | `anthropic/claude-sonnet-4-6` |
| ultrabrain | `anthropic/claude-opus-5` | max | `openai/gpt-5.6-sol` xhigh |
| deep | `anthropic/claude-opus-5` | medium | `ollama-cloud/glm-5.3` |
| artistry | `anthropic/claude-opus-5` | high | |
| quick | `ollama-cloud/glm-5.3-flash` | | `anthropic/claude-haiku-4-5` |
| unspecified-low | `ollama-cloud/glm-5.3` | | `anthropic/claude-haiku-4-5` |
| unspecified-high | `anthropic/claude-opus-5` | high | `ollama-cloud/glm-5.3` |
| writing | `anthropic/claude-sonnet-4-6` | low | `anthropic/claude-opus-5` low |

## Verification

After the edit, a check that parses the JSONC and asserts:

- no string in the file matches `xai/`
- every `agents.*.model` and `categories.*.model` starts with `anthropic/`
  or `ollama-cloud/`
- `$schema` and comments remain
- OpenCode must be restarted for OMO to pick up the file
