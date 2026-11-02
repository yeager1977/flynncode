# Claude agentic coding surfaces

## What coding/agent features exist in Claude Desktop vs Claude Code vs Cowork vs web, and how do they differ?

### Takeaway
Claude Code is one engine surfaced in CLI, IDEs, Desktop Code tab, web cloud, and mobile thin client; Desktop adds visual review/parallel panes while Cowork reuses the agentic loop for non-coding knowledge work and Chat remains non-agentic.

### Cited Findings
- Claude Code is an agentic coding tool available in terminal, IDE, desktop app, and browser that reads codebase, edits files, runs commands, integrates with dev tools — [Source](https://code.claude.com/docs/en/overview.md)
- Each surface connects to same underlying Claude Code engine, so repo CLAUDE.md, settings, MCP servers work across them — [Source](https://code.claude.com/docs/en/overview.md)
- CLI is most complete for terminal-native work: scripting and Agent SDK are CLI-only, third-party providers also work in VS Code and JetBrains — [Source](https://code.claude.com/docs/en/platforms.md)
- Desktop trades CLI-only features for visual review and tighter editor integration; web runs in cloud so tasks keep going after disconnect; mobile is thin client into cloud sessions or local via Remote Control — [Source](https://code.claude.com/docs/en/platforms.md)
- VS Code extension provides inline diffs, @-mentions, plan review, conversation history; JetBrains plugin provides interactive diff viewing and selection sharing — [Source](https://code.claude.com/docs/en/overview.md)
- Desktop app has three tabs: Chat for conversations, Cowork for Dispatch and longer agentic work, Code for software development — [Source](https://code.claude.com/docs/en/desktop.md)
- In Code tab each conversation is a session with own history and project folder; before first message configure Environment (Local/Cloud/SSH/WSL), Project folder, Model, Permission mode — [Source](https://code.claude.com/docs/en/desktop.md)
- Desktop Code features: diff viewer with inline comments, app preview Browser pane with auto-verify, iOS Simulator pane, drag-and-drop panes, integrated terminal and file editor, side chats, computer use, Dispatch, PR monitoring, connectors — [Source](https://code.claude.com/docs/en/desktop.md)
- Cowork is built for non-coding knowledge work — research, analysis, document creation — uses same agentic approach as Claude Code; Code is built for writing/debugging/shipping code — [Source](https://claude.com/product/cowork)
- In regular chat Claude responds but cannot access files directly; in Cowork Claude has permission to read/edit/create files in folders you specify — [Source](https://claude.com/product/cowork)
- Cowork runs on desktop, with web and mobile in beta; desktop app adds folders/applications on own computer — [Source](https://claude.com/product/cowork)
- Cowork file types: docx/doc, pdf, txt/md/html/json/csv/tsv, xlsx/xls/xlsm, pptx/ppt, png/jpg/gif/svg/webp, yaml/xml/toml, ipynb, plus any code language — [Source](https://claude.com/product/cowork)
- Claude Cowork is now just Claude, rolling out to Pro and Max with more plans to follow — [Source](https://claude.com/product/cowork)
- Customize with CLAUDE.md/AGENTS.md, auto memory, skills like /review-pr, hooks like auto-format after edit — [Source](https://code.claude.com/docs/en/overview.md)
- `Task` tool renamed to `Agent` in v2.1.63, `Task(...)` references still work as aliases — [Source](https://code.claude.com/docs/en/sub-agents.md)

### Inferences
- Flynncode gap: unify local visual review (Desktop-style diff/browser/terminal panes) with CLI completeness rather than forking engines per surface.
- Cowork vs Code split is positioning, not separate agent runtime; both share permissions/MCP/skills vocabulary.

### Gaps
- No reliable source found on claude.ai web Chat agentic coding limits vs Code web session parity beyond sharing statement; web Chat file/project behavior not quantified.
- Pricing/limits distinction for Cowork consuming limits faster than Chat noted qualitatively only — [Source](https://claude.com/product/cowork) — without numeric multipliers.

## How does execution work (local machine, cloud sandbox, VMs)? How do permissions/approvals work?

### Takeaway
Local runs execute on user machine/SSH/WSL with full FS/shell; cloud runs in isolated Anthropic VMs or org self-hosted runners with network allowlists, proxied GitHub creds, and pre-approved edits; permissions are deny>ask>allow rules plus Manual/AcceptEdits/Plan/Auto/DontAsk/Bypass modes.

### Cited Findings
- Cloud session runs on cloud infrastructure instead of machine; by default Anthropic-managed, or org self-hosted environment when routed there; keeps running after laptop closed — [Source](https://code.claude.com/docs/en/claude-code-on-the-web.md)
- Each cloud session separated via isolated VMs, network access controls, credential protection where git creds stay outside sandbox and proxy authenticates with scoped creds — [Source](https://code.claude.com/docs/en/claude-code-on-the-web.md)
- Cloud environments control network access, env vars, setup scripts; Default environment uses Trusted access allowing only default allowlist of registries/cloud APIs; connectors reach services via Anthropic servers without allowlist changes — [Source](https://code.claude.com/docs/en/routines.md)
- Setup script result is cached so it does not re-run every session — [Source](https://code.claude.com/docs/en/routines.md)
- GitHub access via Claude GitHub App (any public + installed privates, enables Auto-fix) or /web-setup sending local gh token; in Anthropic-hosted envs creds stay encrypted and never enter VM, operations go through GitHub proxy — [Source](https://code.claude.com/docs/en/claude-code-on-the-web.md)
- Self-hosted environments run cloud sessions on infra you control: deploy runners, route sessions there, on Team/Enterprise — [Source](https://code.claude.com/docs/en/platforms.md)
- Zero Data Retention or HIPAA-configured orgs cannot use /web-setup or other cloud features — [Source](https://code.claude.com/docs/en/claude-code-on-the-web.md)
- IP allowlisting causes every Anthropic-hosted cloud session to fail auth; self-hosted calls API from own network — [Source](https://code.claude.com/docs/en/claude-code-on-the-web.md)
- Tiered permission: read-only (reads/grep) no approval in working dirs; Bash yes except built-in read-only set; file mod yes; WebFetch yes except preapproved docs; WebSearch yes — [Source](https://code.claude.com/docs/en/permissions.md)
- Permission prompt shows action with Yes / Yes-don't-ask-again (saved to .claude/settings.local.json at repo root) / Yes-switch-to-auto / No; file-mod approval lasts until session end — [Source](https://code.claude.com/docs/en/permissions.md)
- /permissions dialog manages Allow/Ask/Deny; evaluated deny then ask then allow, specificity does not change order; bare `Bash` deny removes tool from context — [Source](https://code.claude.com/docs/en/permissions.md)
- Modes: default/Manual prompts first use, acceptEdits auto-accepts edits+mkdir/touch/mv/cp, plan read-only explore, auto classifier reviews shell/network, dontAsk auto-denies prompts, bypassPermissions skips prompts except actions no mode auto-approves — [Source](https://code.claude.com/docs/en/permissions.md)
- bypassPermissions only in isolated containers/VMs; can be disabled via permissions.disableBypassPermissionsMode — [Source](https://code.claude.com/docs/en/permissions.md)
- Bash rules match whole command text, `*` family coverage, compound `&&/||/;/|/|&` requires each subcommand match, wrappers timeout/time/nice/nohup stripped, read-only set includes ls/cat/echo/pwd/head/tail/grep/find/wc/which/diff/stat/du/cd + read-only git — [Source](https://code.claude.com/docs/en/permissions.md)
- Read deny also blocks Edit/Write on same path; NotebookEdit needs Edit deny; .claudeignore has no effect, move entries to Read deny — [Source](https://code.claude.com/docs/en/permissions.md)
- In Cowork session Claude runs shell via mcp__workspace__bash not built-in Bash, and web via mcp__workspace__web_fetch; whole-tool Bash/WebFetch deny applies to Cowork tools, allow does not carry over — [Source](https://code.claude.com/docs/en/permissions.md)
- Desktop mode selector: Manual/default, Accept edits, Plan, Auto (classifier), Bypass (Pro/Max toggle, org policy on Team/Enterprise); dontAsk CLI-only; cloud supports Accept edits (=default pre-approved edits), Plan, Auto, no Bypass — [Source](https://code.claude.com/docs/en/desktop.md)
- Routines run autonomously as full cloud sessions: no permission-mode picker, shell/skills/connectors without approval apart from some artifact actions — [Source](https://code.claude.com/docs/en/routines.md)
- Auto-fix watches PR and pushes clear fixes, asks on ambiguous, notes duplicates; replies posted as user but labeled Claude Code; comment-triggered automation like Atlantis can be triggered — [Source](https://code.claude.com/docs/en/claude-code-on-the-web.md)

### Inferences
- Permission enforcement is host-side (Claude Code, not model); CLAUDE.md cannot grant access, only shape intent.
- Cloud secure-by-default = Trusted allowlist + proxied creds + network secrets outside sandbox; local secure-by-choice = sandbox/sandboxed Bash, devcontainers, Docker, VMs.

### Gaps
- No reliable source found on exact VM specs, region placement, or retention lifetimes beyond expiry-on-inactivity note.
- Sandboxed Bash vs sandbox runtime vs devcontainer decision matrix referenced but full comparison page not fetched.

## What do MCP integrations, subagents, scheduled/background tasks, and cross-device/mobile look like?

### Takeaway
MCP is the USB-C integration layer (Connectors UI + .mcp.json + per-subagent servers + org allowlists); subagents are markdown-defined workers with isolated context; Routines/Desktop tasks//loop cover cloud/local/in-session scheduling; phones/browsers steer via Remote Control, Dispatch, --cloud/--teleport, Slack/Tag, Chrome.

### Cited Findings
- MCP is open standard connecting AI apps to data/tools/workflows; like USB-C for AI — [Source](https://modelcontextprotocol.io/)
- Connectors are MCP servers with graphical setup; use for quick integration, for others add MCP manually via settings; custom connectors via remote MCP — [Source](https://code.claude.com/docs/en/desktop.md)
- For local/SSH click + > Connectors to add Calendar/Slack/GitHub/Linear/Notion; + button not in cloud/WSL, routines configure connectors at creation — [Source](https://code.claude.com/docs/en/desktop.md)
- Routines include all connected MCP connectors by default; remove unneeded because Claude can use every tool including writes without asking — [Source](https://code.claude.com/docs/en/routines.md)
- MCP rules: mcp__puppeteer any tool, mcp__puppeteer__* wildcard, mcp__puppeteer__puppeteer_navigate single tool; org ask on connector forces prompt even in auto/bypass, denies in dontAsk — [Source](https://code.claude.com/docs/en/permissions.md)
- Subagents run own context, custom prompt, tool access, independent permissions; delegate when side task would flood main context, returns summary — [Source](https://code.claude.com/docs/en/sub-agents.md)
- Built-ins: Explore fast read-only (Write/Edit denied, skips CLAUDE.md/git snapshot), Plan for plan-mode research, General-purpose full tools, helpers statusline-setup/claude-code-guide — [Source](https://code.claude.com/docs/en/sub-agents.md)
- Subagent file is Markdown YAML frontmatter: required name/description, optional tools/disallowedTools/model/permissionMode/maxTurns/skills/mcpServers/hooks/memory/background/omitClaudeMd/effort/isolation — [Source](https://code.claude.com/docs/en/sub-agents.md)
- Scope priority: Managed > --agents CLI > .claude/agents/ project > ~/.claude/agents/ user > plugin agents/ — [Source](https://code.claude.com/docs/en/sub-agents.md)
- Model order: per-invocation param > frontmatter (inherit=main) > CLAUDE_CODE_SUBAGENT_MODEL > main model; plus CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 to force all — [Source](https://code.claude.com/docs/en/sub-agents.md)
- Subagent permissionMode ignored when main is bypass/acceptEdits/auto (inherits main, classifier reviews); honored in default/dontAsk/plan except bypass request keeps main — [Source](https://code.claude.com/docs/en/sub-agents.md)
- Background subagents keep only Read/Grep/Glob/LSP/Bash/PowerShell/Edit/Write/NotebookEdit/WebFetch/WebSearch/TodoWrite/Skill/ToolSearch/EnterWorktree/ExitWorktree/Monitor/TaskStop/SendMessage/Artifact plus all MCP; foreground inherits more — [Source](https://code.claude.com/docs/en/sub-agents.md)
- isolation:worktree runs subagent in temp git worktree branched from default branch, auto-cleaned if no changes — [Source](https://code.claude.com/docs/en/sub-agents.md)
- Block specific built-in via permissions.deny, any delegation via deny Agent, remove Explore/Plan via CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1 — [Source](https://code.claude.com/docs/en/sub-agents.md)
- Routines: saved prompt+repos+connectors, run on Anthropic cloud or self-hosted, triggers Scheduled/API/GitHub, research preview, Pro/Max/Team/Enterprise, create at claude.ai/code/routines or /schedule — [Source](https://code.claude.com/docs/en/routines.md)
- API trigger POST /fire with Bearer, optional text wrapped in <routine-fire-payload> as untrusted unless prompt opts in; beta header experimental-cc-routine-2026-04-01 — [Source](https://code.claude.com/docs/en/routines.md)
- GitHub triggers on PR opened/closed/assigned/labeled/synced + Release created/published/edited/deleted, with author/title/body/base/head/labels/draft/merged filters — [Source](https://code.claude.com/docs/en/routines.md)
- Desktop scheduled tasks run on machine with local files vs Routines cloud; /loop repeats prompt within CLI session — [Source](https://code.claude.com/docs/en/overview.md)
- Work away matrix: Dispatch (phone→Desktop machine), Remote Control (drive running session from web/mobile), Channels (Telegram/Discord/webhooks into CLI), Slack @Claude (Anthropic cloud Pro/Max), Self-hosted (org infra), Scheduled (CLI/Desktop/cloud) — [Source](https://code.claude.com/docs/en/platforms.md)
- Remote Control: continue local CLI/Desktop/VS Code session from phone/tablet/browser via claude remote-control or /remote-control — [Source](https://code.claude.com/docs/en/platforms.md)
- Dispatch: persistent Cowork conversation; ask for Code session or auto-routes bug/test/PR work to Code with Dispatch badge + phone push; Pro/Max only, not Team/Enterprise — [Source](https://code.claude.com/docs/en/desktop.md)
- claude --cloud creates new cloud session cloning GitHub remote at current branch (push first); --remote deprecated alias; --teleport pulls cloud branch+history into terminal (one-way, clean git, same repo/account required) — [Source](https://code.claude.com/docs/en/claude-code-on-the-web.md)
- Send follow-ups via claude -p msg --cloud <session-id|URL>, posts once and exits — [Source](https://code.claude.com/docs/en/claude-code-on-the-web.md)
- Slack responds to @Claude under own account (Pro/Max, earlier version); Claude Tag runs @Claude as org shared identity with admin access (Team/Enterprise) — [Source](https://code.claude.com/docs/en/platforms.md)
- Chrome controls browser with logged-in sessions for testing/filling; computer use CLI macOS lets Claude open apps/click/type/see screen — [Source](https://code.claude.com/docs/en/platforms.md)
- Desktop Browser pane is clean profile separate from personal; Chrome extension shares login state for acting as you — [Source](https://code.claude.com/docs/en/desktop.md)
- Cowork built-in browser in side panel separate from own browser/logins/tabs, no install, sign in per session or import Chrome/Edge/Firefox cookies — [Source](https://claude.com/product/cowork)
- Computer use tries connector > Bash > Chrome > iOS Simulator > screen control; browsers view-only, terminals/IDEs click-only, rest full; per-app Allow session/30min Dispatch, asks each app — [Source](https://code.claude.com/docs/en/desktop.md)

### Inferences
- Three schedulers are complementary: Routines for unattended cloud automation, Desktop tasks for local cron with FS, /loop for in-session polling.
- Cross-device is session-handoff primitives (teleport/cloud/open-in) + live steering (Remote Control) + fire-and-forget delegation (Dispatch/--cloud/Slack).

### Gaps
- No reliable source found on mobile push exact events beyond limit-reset pings and Dispatch finish/approval notices.
- Memory sync semantics (auto memory vs claude.ai synced skills checking every ~40min) only partially sourced from changelog; full memory architecture not fetched.

## What changed in the last ~6 months (changelog-level, with dates where possible)?

### Takeaway
Apr–Oct 2026 shipped cloud Sessions/Projects/Routines, auto mode default, agent teams/messaging, Desktop Linux/iOS/computer-use background, Chrome GA, Sonnet/Opus/Fable 5.x becoming defaults, plus Cowork browser/enterprise and Haiku/Sonnet/Opus 5.5 cost/speed wins.

### Cited Findings
- Week 37 Sep 7–11 2026: claude plugin eval, pop Desktop panes to windows — [Source](https://code.claude.com/docs/llms.txt)
- Week 36 Aug 31–Sep 4 2026: switch to Fable 5.1, computer use background on Desktop, live /diff panel — [Source](https://code.claude.com/docs/llms.txt)
- Week 35 Aug 24–28 2026: resume terminal in Desktop, feedback reports, restricted mode — [Source](https://code.claude.com/docs/llms.txt)
- Week 34 Aug 17–21 2026: /design skill editable artboards, Concise output, start machine session from phone — [Source](https://code.claude.com/docs/llms.txt)
- Week 33 Aug 10–14 2026: auto-continue after limit reset, fork mode default, GitLab MRs+marketplaces join GitHub — [Source](https://code.claude.com/docs/llms.txt)
- Week 32 Aug 3–7 2026: sessions message each other, self-hosted envs run cloud on own infra, auto mode default — [Source](https://code.claude.com/docs/llms.txt)
- Week 30 Jul 20–24 2026: Opus 5 default Opus, Desktop iOS Simulator pane, Security plugin scans code — [Source](https://code.claude.com/docs/llms.txt)
- Week 29 Jul 13–17 2026: live data into published artifacts via MCP, screen-reader mode — [Source](https://code.claude.com/docs/llms.txt)
- Week 28 Jul 6–10 2026: Desktop built-in browser external sites, /doctor setup checkup, auto-mode transcript protections + agent view upgrades — [Source](https://code.claude.com/docs/llms.txt)
- Week 27 Jun 29–Jul 3 2026: Sonnet 5 default, Chrome GA, subagents background by default, Desktop Linux beta, /radio Claude FM — [Source](https://code.claude.com/docs/llms.txt)
- Week 26 Jun 22–26 2026: claude mcp login shell auth, ! shell-mode prefix, /rewind after /clear — [Source](https://code.claude.com/docs/llms.txt)
- Week 25 Jun 15–19 2026: Artifacts live shareable pages, deny/ask match tool params, /config any setting from prompt — [Source](https://code.claude.com/docs/llms.txt)
- Week 24 Jun 8–12 2026: /cd move dir, subagents spawn subagents, safe mode for broken config — [Source](https://code.claude.com/docs/llms.txt)
- Week 23 Jun 1–5 2026: auto mode on Bedrock/Agent Platform/Foundry, acceptEdits prompts before writing runnable files, /plugin list, managed version ranges — [Source](https://code.claude.com/docs/llms.txt)
- Week 22 May 25–29 2026: Opus 4.8, dynamic workflows orchestrate large tasks, security-guidance plugin, fast mode Opus cheaper — [Source](https://code.claude.com/docs/llms.txt)
- Week 21 May 18–22 2026: auto mode on Pro + Sonnet 4.6, /usage what drives limits, /code-review command — [Source](https://code.claude.com/docs/llms.txt)
- Week 20 May 11–15 2026: agent view manage all sessions, /goal persist until condition, fast mode Opus 4.7 default — [Source](https://code.claude.com/docs/llms.txt)
- Week 19 May 4–8 2026: plugins from zip/URL, Ctrl+R history, worktrees from HEAD/remote, auto hard-deny rules — [Source](https://code.claude.com/docs/llms.txt)
- Week 17 Apr 20–24 2026: /ultrareview research preview, auto recaps, custom themes in plugins, redesigned web — [Source](https://code.claude.com/docs/llms.txt)
- Week 16 Apr 13–17 2026: Opus 4.7 xhigh effort, Routines on web, mobile push when Claude needs you, /usage breakdown, native binaries — [Source](https://code.claude.com/docs/llms.txt)
- 2.1.293 Oct 7 2026: Haiku 5.5 default Haiku 1M context $0.10/$0.50 ( $0.50/$2.50 >100K), subagentStatusLine agentType, mods isDeferred, compaction redo fix — [Source](https://code.claude.com/docs/en/changelog.md)
- 2.1.292 Oct 6 2026: plugin install --marketplace, Agent effort param, routines publish new artifact private-only without approval — [Source](https://code.claude.com/docs/en/changelog.md)
- 2.1.290 Oct 5 2026: mod turn.step serverToolUses, claude attach/logs by name, WebSearch 100/hr refill, pyright no longer read-only, --teleport vs --resume distinction — [Source](https://code.claude.com/docs/en/changelog.md)
- Haiku 5.5 Oct 7 2026 fastest/cheapest capable small model — [Source](https://www.anthropic.com/news)
- Sonnet 5.5 Sep 28 2026 clear upgrade 30% faster up to 30% less — [Source](https://www.anthropic.com/news)
- Opus 5.5 Sep 22 2026 Fable 5.1-level most work 40% less than Opus 5 — [Source](https://www.anthropic.com/news)
- Cowork built-in browser Aug 26 2026 open/fill/finish web in Cowork panel — [Source](https://claude.com/product/cowork)
- Cowork enterprise Apr 9 2026 manage access/spend/usage — [Source](https://claude.com/product/cowork)
- Cowork plugin marketplace Feb 24 2026 private marketplaces (older than 6mo, marked deprecated window) — [Source](https://claude.com/product/cowork)

### Inferences
- Trajectory: defaults moving to 5.x (Sonnet→Opus→Fable 5.1) with cost/speed 5.5 refresh; autonomy moving to auto mode + background subagents + cloud routines/self-hosted.
- Desktop maturing to IDE alternative: panes/pop-outs, Linux, iOS simulator, background computer use, phone-initiated sessions.

### Gaps
- Changelog beyond Oct 5–7 truncated in fetch; Apr–Sep daily patch notes not exhaustively enumerated.
- No reliable source found on exact Cowork-is-now-Claude migration date beyond rolling-out note; needs support article fetch.
