# Flynncode desktop feature inventory

Read-only inventory of the Flynncode fork at `/home/yeager1977/GitHub/flynncode`. Facts below are from files that exist in this repo. Spec `Status:` lines are quoted as written; several Draft specs already have matching implementation files, so spec status is not treated as proof that code is missing.

## Desktop session UI

### Takeaway

The session page already has a review pane, file tree, terminal, todo dock, subagent/tasks list, message timeline, composer docks, and permission prompts. v1 and v2 layouts coexist behind a settings flag.

### Cited Findings

- The Electron desktop package is a shell around the app. `packages/desktop/README.md` still titles it "OpenCode Desktop" and says it is built with Electron. Renderer code must call `window.api` from preload; main-process IPC is registered in `src/main/ipc.ts`. — [packages/desktop/README.md](file:///home/yeager1977/GitHub/flynncode/packages/desktop/README.md); [packages/desktop/AGENTS.md](file:///home/yeager1977/GitHub/flynncode/packages/desktop/AGENTS.md)
- Session side panel (`SessionSidePanel`) owns review and file-tree visibility. Review opens on desktop when `view().reviewPanel.opened()`. The file tree opens only when `settings.visibility.fileTree` is on and `layout.fileTree.opened()`. Minimum file-tree width is 240. It imports `FileTree`, `SessionFileBrowserTab`, and `SubagentList`. — [packages/app/src/pages/session/session-side-panel.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/session-side-panel.tsx)
- Review v1 is `packages/app/src/pages/session/review-tab.tsx`, which mounts `@opencode-ai/session-ui/session-review` and can emit line comments (`onLineComment` with file, selection, comment, preview). Review v2 is `packages/app/src/pages/session/v2/review-panel-v2.tsx`: `SessionReviewV2`, a sidebar, `FileTreeV2`, file preview, and diff kinds from `review-diff-kinds.ts`. — [review-tab.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/review-tab.tsx); [review-panel-v2.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/v2/review-panel-v2.tsx)
- File tabs and a v2 file browser exist: `file-tabs.tsx`, `v2/session-file-list-v2.tsx`, `v2/session-file-browser-tab.tsx`. A helper test states a disabled file tree does not reserve space. — [file-tabs.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/file-tabs.tsx); [helpers.test.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/helpers.test.ts)
- Terminal UI exists as `terminal-panel.tsx` and `terminal-panel-v2.tsx`, plus sortable terminal tabs. `TerminalPanel` uses `useTerminal()`, a `Terminal` component, and can show `SubagentList` when `sessionShowsSubagents` is true. The 2026-09-23 spec says the session terminal already accepts keystrokes and paste through a real PTY; the agent shell tool does not. — [terminal-panel.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/terminal-panel.tsx); [interactive-terminal-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-23-interactive-terminal-design.md)
- Todo dock is `SessionTodoDock` in the composer region. It renders SDK `Todo` items with status, collapse/expand, and done/total counts. — [session-todo-dock.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/composer/session-todo-dock.tsx)
- Subagent/tasks pane is `SubagentList`. It lists child sessions (`parentID`) plus tasks parsed from message parts, grouped, with expand state on the session view. It is imported by both the side panel and the terminal panel. A design spec exists at `docs/superpowers/specs/2026-09-24-subagent-list-design.md`. A later spec, `2026-09-29-session-task-chips-design.md`, was not checked against code in this pass. — [subagent-list-view.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/subagent-list-view.tsx); [subagent-list.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/subagent-list.ts)
- Timeline is `MessageTimeline` plus `timeline/model.ts`, `projection.ts`, and `rows.ts`. The model syncs session messages and refreshes stale sessions after 15 seconds. The timeline UI calls `session.share` / `session.unshare` and opens the share URL externally. — [message-timeline.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/timeline/message-timeline.tsx); [timeline/model.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/timeline/model.ts)
- Composer is `SessionComposerRegion`. It stacks question, permission, followup, revert, and todo docks above the prompt input. Permission dock decisions are `"once" | "always" | "reject"`. — [session-composer-region.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/composer/session-composer-region.tsx); [session-permission-dock.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/composer/session-permission-dock.tsx)
- v2 chrome is gated by `settings.general.newLayoutDesigns()` in the composer region. Session header, context tab, and open-in-app have v1 and v2 components under `packages/app/src/components/session`. — [session-composer-region.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/composer/session-composer-region.tsx); [packages/app/src/components/session](file:///home/yeager1977/GitHub/flynncode/packages/app/src/components/session)

### Inferences

- A later design should not add a second review pane, file tree, terminal, todo list, subagent list, timeline, or permission prompt. Those surfaces already exist in `packages/app`, which the desktop shell hosts.
- v1 and v2 are parallel implementations, not a missing feature. New work should pick the layout flag rather than invent a third panel.

### Gaps

- Whether the 2026-09-23 interactive-terminal handoff (`ptyID`, sudo/ssh/su/passwd) is implemented was not verified. Only the existing terminal panel and the spec's problem statement were confirmed.
- Whether session task chips from `2026-09-29-session-task-chips-design.md` shipped was not verified.
- No dedicated "permissions pane" separate from the composer permission dock and settings permission copy was found in the session page file list.

## Plugins, skills, MCP, model router, scheduled routines, artifacts, dispatch, notifications

### Takeaway

Flynncode already ships a desktop plugin manager, MCP settings plus registry search, a built-in Ollama model router, a local routines scheduler, an artifacts sidebar, a dispatch panel, and unfocused-window notifications. Skills are a core/server feature with slash-command UI, not a desktop skills editor.

### Cited Findings

- Built-in server plugins imported directly (not npm) include provider auth plugins plus `OllamaModelRouterPlugin` and `RoutinesPlugin`. — [packages/opencode/src/plugin/index.ts](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/plugin/index.ts)
- Desktop plugin manager reads and mutates global and project config, fetches a catalog, and stores recently removed plugins. Settings UI is `packages/app/src/components/settings-v2/plugins.tsx`. Design: `docs/superpowers/specs/2026-09-03-desktop-plugin-manager-design.md` and `2026-09-21-plugin-toggles-design.md`. — [plugin-manager.ts](file:///home/yeager1977/GitHub/flynncode/packages/desktop/src/main/plugin-manager.ts); [plugins.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/components/settings-v2/plugins.tsx)
- Skills live in core (`packages/core/src/skill.ts`) with directory, URL, and embedded sources, a skill tool, and an HTTP handler (`packages/server/src/handlers/skill.ts`). The app slash popover badges commands whose `source === "skill"`. No `packages/app/src/**/*skill*` settings page was found. — [packages/core/src/skill.ts](file:///home/yeager1977/GitHub/flynncode/packages/core/src/skill.ts); [slash-popover.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/components/prompt-input/slash-popover.tsx)
- MCP settings support local and remote servers (`settings-v2/mcp.tsx`, `mcp-payload.ts`). Registry search maps package and remote entries (`mcp-registry.tsx`, `mcp-registry-payload.ts`). Designs: `2026-09-03-mcp-server-management-design.md`, `2026-09-22-mcp-registry-search-design.md`. — [mcp.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/components/settings-v2/mcp.tsx); [mcp-registry.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/components/settings-v2/mcp-registry.tsx)
- Ollama model router is Flynncode-specific at `packages/opencode/src/plugin/ollama-model-router`. It loads by default, reads `model_router` from config, and is inert when that key is absent. `enabled: false` keeps the scorecard but does not inject routing. Tools are `rank_models` and `route_task`. Settings UI is `settings-v2/model-router.tsx` plus models, routes, and preview files. README says `/route <task> <prompt>` uses `route_task` when the command file exists. — [ollama-model-router/index.ts](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/plugin/ollama-model-router/index.ts); [tools.ts](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/plugin/ollama-model-router/tools.ts); [README.md](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/plugin/ollama-model-router/README.md)
- Routines plugin loads `routines` from `opencode.jsonc` / `opencode.json` / `config.json`, else `~/.config/opencode/routines.jsonc`. A 30-second timer runs due routines by creating a session and calling `session.promptAsync` with agent `"build"`. Settings UI is `settings-v2/routines.tsx`. Spec status is still Draft; scope is manual plus `{ dailyAt: "HH:MM" }` only. Out of scope in that spec: full cron, webhooks, run history beyond last-run, notifications. — [routines/index.ts](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/plugin/routines/index.ts); [routines-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-22-routines-design.md)
- Artifacts sidebar code groups changed files from `session_diff` by session, max 20 groups, and links to `/{slug}/session/{id}?file=`. Spec status is Draft and says non-project artifacts (screenshots, exported notes) and mobile are out of scope. — [sidebar-artifacts.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/layout/sidebar-artifacts.ts); [artifacts-sidebar-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-22-artifacts-sidebar-design.md)
- Dispatch is a local task list (`DispatchTask` with sessionID, title, status, directory; cap 40) and `dispatch-panel.tsx`. Spec status is Draft. It describes a sidebar overlay that creates a session and prompts it. Out of scope there: scheduling, attachments, multi-target broadcast, notification integration. — [dispatch-store.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/dispatch/dispatch-store.ts); [dispatch-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-22-dispatch-design.md)
- App notifications are turn-complete and error records in `packages/app/src/context/notification.tsx`. Desktop OS notifications fire only when the window is not focused, via `new Notification`, and click focuses the window. — [notification.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/context/notification.tsx); [packages/desktop/src/renderer/index.tsx](file:///home/yeager1977/GitHub/flynncode/packages/desktop/src/renderer/index.tsx)
- The 2026-09-21 surface portfolio lists five cycles: OMO allowlist models, OpenCode Mobile, artifacts sidebar, routines menu, dispatch. Its status is Draft. It says the router is off on "this machine" (`model_router.enabled: false`). That is a design note about a machine config, not a code default. — [desktop-surface-portfolio-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-21-desktop-surface-portfolio-design.md)

### Inferences

- Do not propose a new plugin manager, MCP settings page, model-router settings page, routines menu, artifacts sidebar, or dispatch panel. Those files already exist.
- Do not propose a skills manager unless the missing piece is a settings UI. Discovery, URL sources, and slash invocation already exist.
- Router and routines are Flynncode built-ins. Third-party plugin work still has to be checked against the router, per root `AGENTS.md`.

### Gaps

- Spec Draft status versus existing files was not reconciled line-by-line. Completeness of artifacts, dispatch, and routines against their specs was not audited.
- Whether `/route` command file is present in this repo was not confirmed; the router README conditions that on the command file existing.
- No desktop skills editor file was found. A settings page under another name was not exhaustively ruled out.

## Local-only versus remote server

### Takeaway

The desktop app defaults to a local sidecar server and can also attach to remote HTTP servers and WSL sidecars. Provider calls, MCP remote transports, skill URL sources, and session share links leave the machine. Phone access is a same-LAN gateway, not a cloud control plane.

### Cited Findings

- Desktop main process can spawn a local utility-process sidecar (`sidecar.js`, service name `"opencode server"`) and persist `defaultServerUrl`. — [packages/desktop/src/main/server.ts](file:///home/yeager1977/GitHub/flynncode/packages/desktop/src/main/server.ts)
- App server scope treats `"sidecar"` and the canonical local server key as `ServerScope.local`. Any other server key is stored as its own scope, and tests treat URL keys such as `https://opencode.example.com` and `https://debian.example` as remote. Persistence isolates remote storage from local storage. — [server-scope.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/utils/server-scope.ts); [server.test.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/context/server.test.ts); [persist.test.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/utils/persist.test.ts)
- Settings has a servers page that lists non-WSL servers by name and HTTP URL, plus WSL server settings. A test says WSL sidecars are treated as remote server connections. WSL main process can spawn a sidecar per distro and store a URL, username, and password. — [servers.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/components/settings-v2/servers.tsx); [wsl/servers.ts](file:///home/yeager1977/GitHub/flynncode/packages/desktop/src/main/wsl/servers.ts)
- Local app dev talks to a local backend: app on port 4444, backend `bun run ./src/index.ts serve --port 4096`. `opencode dev web` proxies `https://app.opencode.ai` and does not show local UI changes. — [packages/app/AGENTS.md](file:///home/yeager1977/GitHub/flynncode/packages/app/AGENTS.md)
- MCP forms have `kind: "local" | "remote"`. Registry entries map to stdio or a remote URL plus headers. — [mcp-payload.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/components/settings-v2/mcp-payload.ts); [mcp-registry-payload.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/components/settings-v2/mcp-registry-payload.ts)
- Model router ranks models from the connected provider catalog (`client.provider.list()`), with config providers as fallback. That catalog includes remote providers such as `ollama-cloud`, `anthropic`, `openai`, and `xai` in the README example. — [ollama-model-router/index.ts](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/plugin/ollama-model-router/index.ts); [README.md](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/plugin/ollama-model-router/README.md)
- Session share creates a URL through `ShareNext` and stores it on the session, unless `conf.share === "disabled"`. HTTP API text says the link lets others view the conversation. The timeline opens that URL with `platform.openExternal`. — [packages/opencode/src/share/session.ts](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/share/session.ts); [session.ts HTTP group](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts)
- `@flynncode/mobile-gateway` is a LAN reverse proxy so a phone on the same network can reach the local server. Default listen host is `0.0.0.0` port 4097. README says the desktop app can load it as a path plugin and that the desktop binds a random port and rotates `OPENCODE_SERVER_PASSWORD`. The portfolio spec says cycle 2 removes `mobile-gateway` from "this machine's" plugin list and uses `opencode-mobile@latest` instead, while the package stays in the repo. — [packages/mobile-gateway/README.md](file:///home/yeager1977/GitHub/flynncode/packages/mobile-gateway/README.md); [mobile-gateway-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-15-mobile-gateway-design.md); [desktop-surface-portfolio-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-21-desktop-surface-portfolio-design.md)
- Skills declare `UrlSource` as well as directory and embedded sources. — [packages/core/src/skill.ts](file:///home/yeager1977/GitHub/flynncode/packages/core/src/skill.ts)
- Dispatch tasks and composer drafts are local. Desktop renderer persists drafts through `window.api.draftGet/Set/Delete` and blob put/get. Routines last-run is written back to the local config or `routines.jsonc`. — [dispatch-store.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/dispatch/dispatch-store.ts); [packages/desktop/src/renderer/index.tsx](file:///home/yeager1977/GitHub/flynncode/packages/desktop/src/renderer/index.tsx); [routines/index.ts](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/plugin/routines/index.ts)
- `packages/enterprise` exists, is private, and has a Cloudflare build script. What it exposes to the desktop app was not read. — [packages/enterprise/package.json](file:///home/yeager1977/GitHub/flynncode/packages/enterprise/package.json)

### Inferences

- "Local desktop" already includes a network client. A design that adds "connect to a server" would duplicate `SettingsServersV2`, server scope, and the sidecar.
- WSL is already a remote-shaped local sidecar, not an unimplemented platform.

### Gaps

- The live plugin list on this machine was not read. README and the portfolio spec disagree about whether desktop currently loads `mobile-gateway`.
- `ShareNext` destination host was not opened. Share is a view link, not proven to be multi-user editing.
- Enterprise package behavior relative to the desktop app was not inventoried.

## Gaps versus a modern coding desktop

### Takeaway

Computer use, scheduled agents on another machine, phone push control, collaborative review, and cross-device memory were not found as desktop features. Nearby pieces exist and should not be rebuilt: PTY terminal, local routines, LAN mobile gateway, view-only session share, and local drafts.

### Cited Findings

- No desktop computer-use surface was found. The only `computer_use` hits are protocol passthrough for OpenAI Responses `computer_use_call` in `packages/llm` and GitHub Copilot response mapping in `packages/core`. `packages/llm/AGENTS.md` says those hosted tools pass through the runtime untouched. — [packages/llm/src/protocols/openai-responses.ts](file:///home/yeager1977/GitHub/flynncode/packages/llm/src/protocols/openai-responses.ts); [packages/llm/AGENTS.md](file:///home/yeager1977/GitHub/flynncode/packages/llm/AGENTS.md)
- Scheduled work that exists is the local routines plugin: 30-second poll, `dailyAt` only, new session on the server process that loaded the plugin. The spec explicitly excludes full cron, webhooks, and notifications. No scheduled remote-agent runner was found. — [routines/index.ts](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/plugin/routines/index.ts); [routines-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-22-routines-design.md)
- Phone reach is the mobile gateway: same-network browser access to the existing web app. The design says iOS will not install a PWA or deliver Web Push over plain LAN HTTP, and a plan note says push notifications are unavailable. No in-repo native phone app was found. Portfolio cycle 2 points at third-party `opencode-mobile`, which is not vendored. — [mobile-gateway-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-15-mobile-gateway-design.md); [desktop-surface-portfolio-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-21-desktop-surface-portfolio-design.md)
- Shared review, as collaborative editing, was not found. What exists is session share/unshare: a link so others can view the conversation, opened externally from the timeline. The in-app review pane is a local diff/comment surface (`review-tab.tsx`, `review-panel-v2.tsx`), not a multi-user review room. — [session HTTP group](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts); [message-timeline.tsx](file:///home/yeager1977/GitHub/flynncode/packages/app/src/pages/session/timeline/message-timeline.tsx)
- Cross-device memory was not found. Local persistence is scoped per server (`Persist` isolates remote keys). Drafts stay in the desktop draft store. Routines state stays in the user config directory. Skills can be loaded from a URL, which is remote content, not a synced memory store. — [persist.test.ts](file:///home/yeager1977/GitHub/flynncode/packages/app/src/utils/persist.test.ts); [packages/core/src/skill.ts](file:///home/yeager1977/GitHub/flynncode/packages/core/src/skill.ts)
- Inter-session messaging exists in code as `<peer_reply>` delivery in `packages/opencode/src/session/prompt.ts`. The 2026-09-30 spec says a session can steer or queue a message to another session without waiting. That is same-server session messaging, not phone or cross-device memory. — [prompt.ts](file:///home/yeager1977/GitHub/flynncode/packages/opencode/src/session/prompt.ts); [session-messaging-design.md](file:///home/yeager1977/GitHub/flynncode/docs/superpowers/specs/2026-09-30-session-messaging-design.md)
- Desktop notifications are local OS notifications when the window is unfocused. They are not push to a phone. — [packages/desktop/src/renderer/index.tsx](file:///home/yeager1977/GitHub/flynncode/packages/desktop/src/renderer/index.tsx)

### Inferences

- A modern-desktop design can add computer use, off-machine schedules, phone push, collaborative review, and synced memory without duplicating the session chrome.
- It should treat routines, dispatch, share links, the LAN gateway, and the review pane as existing and extend them only if the new behavior is actually missing.

### Gaps

- `opencode-mobile` is named in a spec and was not inspected; it is not in this repo.
- Whether `ShareNext` supports comments or only a read-only transcript was not verified.
- No search hit for a product feature named memory sync, computer-use desktop pane, or scheduled remote agent. Absence is from this file search, not a guarantee that a differently named module exists.
