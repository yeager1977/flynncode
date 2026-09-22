# Oh My OpenCode Allowlist Models - Design

Date: 2026-09-21
Status: Implemented

## Problem

The Oh My OpenCode installer wrote `~/.omo/omo.jsonc` with stock chains that
prefer OpenAI and omit Ollama Cloud. Defaults must stay on the user's
allowlist, **Claude over ChatGPT**, **no xAI**, and **coding work must
prefer DeepSeek and GLM 5.3 Flash**, with **Claude on reviews**.

## Goal

Rewrite `[opencode].agents` and `[opencode].categories` in
`~/.omo/omo.jsonc`. Coding roles primary on
`ollama-cloud/glm-5.3-flash` or `ollama-cloud/deepseek-v4.1-flash` (pro
for heavier deep work). Review and orchestration roles primary on
Anthropic. OpenAI only as a last fallback. No `xai/` keys. This machine
only; do not vendor OMO.

## Provider policy

- **Coding (most calls):** `ollama-cloud/glm-5.3-flash` and
  `ollama-cloud/deepseek-v4.1-flash`. Heavier coding:
  `ollama-cloud/deepseek-v4-pro` or `ollama-cloud/glm-5.3`.
- **Reviews / orchestration:** `anthropic/claude-opus-5` or
  `anthropic/claude-sonnet-4-6`.
- **Fallback:** the other cheap Ollama Cloud model, then Anthropic Haiku,
  then OpenAI only if needed.
- **Forbidden:** any `xai/` key.

## Mapping

### Agents

| Agent | Role | Primary | Fallback |
|---|---|---|---|
| sisyphus | orchestrate | `anthropic/claude-opus-5` max | `ollama-cloud/glm-5.3-flash` |
| hephaestus | coding | `ollama-cloud/glm-5.3-flash` | `ollama-cloud/deepseek-v4.1-flash` |
| oracle | review | `anthropic/claude-opus-5` max | `ollama-cloud/glm-5.3` |
| librarian | lookup | `ollama-cloud/glm-5.3-flash` | `ollama-cloud/deepseek-v4.1-flash` |
| explore | lookup | `ollama-cloud/glm-5.3-flash` | `ollama-cloud/deepseek-v4.1-flash` |
| multimodal-looker | lookup | `ollama-cloud/glm-5.3-flash` | `anthropic/claude-haiku-4-5` |
| prometheus | plan | `anthropic/claude-opus-5` high | `ollama-cloud/glm-5.3` |
| metis | plan | `anthropic/claude-opus-5` high | |
| momus | review | `anthropic/claude-opus-5` high | `anthropic/claude-sonnet-4-6` |
| atlas | coding | `ollama-cloud/deepseek-v4.1-flash` | `ollama-cloud/glm-5.3-flash` |
| sisyphus-junior | coding | `ollama-cloud/glm-5.3-flash` | `ollama-cloud/deepseek-v4.1-flash` |

### Categories

| Category | Primary | Fallback |
|---|---|---|
| visual-engineering | `ollama-cloud/glm-5.3-flash` | `anthropic/claude-sonnet-4-6` |
| ultrabrain | `anthropic/claude-opus-5` max | `ollama-cloud/glm-5.3` |
| deep | `ollama-cloud/deepseek-v4-pro` | `ollama-cloud/glm-5.3-flash` |
| artistry | `anthropic/claude-opus-5` high | |
| quick | `ollama-cloud/glm-5.3-flash` | `ollama-cloud/deepseek-v4.1-flash` |
| unspecified-low | `ollama-cloud/glm-5.3-flash` | `ollama-cloud/deepseek-v4.1-flash` |
| unspecified-high | `ollama-cloud/deepseek-v4-pro` | `ollama-cloud/glm-5.3` |
| writing | `anthropic/claude-sonnet-4-6` low | `anthropic/claude-opus-5` low |

## Verification

- no `xai/` in the file
- coding agents/categories primary on `ollama-cloud/glm-5.3-flash`,
  `ollama-cloud/deepseek-v4.1-flash`, or `ollama-cloud/deepseek-v4-pro`
- review agents (`oracle`, `momus`) primary on `anthropic/`
- `$schema` and the top comment remain
- Restart OpenCode
