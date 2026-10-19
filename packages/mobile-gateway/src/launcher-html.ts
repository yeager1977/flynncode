import { projectLabel, relativeTime, sessionSlug, type LauncherData, type LauncherSession, type LauncherTodo } from "./launcher.ts"
import type { InboxItem } from "./inbox.ts"
import type { RelayDigest } from "./relay.ts"

const RUNNING_BADGE = "running"
const SUBAGENT_BADGE = "subagent"
const TASKS_DONE_LABEL = "done"
const TASKS_TODO_LABEL = "todo"
// Statuses the CSS knows; a status from the model outside this set stays
// unstyled instead of becoming part of a class name.
const TASK_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"])

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function taskBlock(session: LauncherSession) {
  const todos = session.todos
  if (!todos?.length) return ""
  const done = todos.filter((todo) => todo.status === "completed").length
  const open = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length
  // A native <details> disclosure: the summary is a tappable tasks affordance
  // with no script, and expanding lists the items in place.
  const items = todos
    .map((todo) => {
      const className = TASK_STATUSES.has(todo.status) ? ` class="${todo.status}"` : ""
      return `<li${className}>${escapeHtml(todo.content)}</li>`
    })
    .join("")
  return `<details class="tasks"><summary>${done} ${TASKS_DONE_LABEL} / ${open} ${TASKS_TODO_LABEL}</summary><ul>${items}</ul></details>`
}

function row(session: LauncherSession, now: number, running: boolean) {
  const title = `<span class="title">${escapeHtml(session.title)}</span>`
  const badges = `${running ? ` &middot; ${RUNNING_BADGE}` : ""}${session.subagent ? ` &middot; ${SUBAGENT_BADGE}` : ""}`
  // A placeholder session (running but outside the recent window) has no known update
  // time; showing "20000d ago" would be worse than showing nothing.
  const when = session.updated > 0 ? ` &middot; ${escapeHtml(relativeTime(session.updated, now))}` : ""
  const meta = `<span class="meta">${escapeHtml(projectLabel(session.directory))}${when}${badges}</span>`
  const tasks = taskBlock(session)
  if (session.directory === undefined || !tasks) {
    const body = `${title}${meta}${tasks}`
    if (session.directory === undefined) return `<div class="row">${body}</div>`
    return `<a class="row" href="${escapeHtml(`/${sessionSlug(session.directory)}/session/${encodeURIComponent(session.id)}`)}">${body}</a>`
  }
  // A disclosure element cannot nest inside a link, so a row with tasks splits
  // into the link side and the task list; the card look stays on .row.
  const href = `/${sessionSlug(session.directory)}/session/${encodeURIComponent(session.id)}`
  return `<div class="row"><a class="row-link" href="${escapeHtml(href)}">${title}${meta}</a>${tasks}</div>`
}

function section(heading: string, rows: string[]) {
  return `<section><h2>${escapeHtml(heading)}</h2>${rows.join("")}</section>`
}

function inboxRow(item: InboxItem) {
  const href = item.directory === undefined ? undefined : `/${sessionSlug(item.directory)}/session/${encodeURIComponent(item.sessionID)}?needs-input=1`
  const label = item.kind === "permission" ? "Approval needed" : "Question waiting"
  const inner = `<span class="title">${escapeHtml(item.title)}</span><span class="meta">${escapeHtml(label)}</span>`
  if (href === undefined) return `<div class="row">${inner}</div>`
  return `<a class="row" href="${escapeHtml(href)}">${inner}</a>`
}

export function renderLauncher(input: { data: LauncherData; now: number; partial: boolean; inbox?: InboxItem[]; relay?: RelayDigest[] }) {
  const running = input.data.running.length
    ? section("Running now", input.data.running.map((session) => row(session, input.now, true)))
    : `<p class="quiet">Nothing is running.</p>`

  const groups = input.data.groups.length
    ? input.data.groups
        .map((group) => section(group.label, group.sessions.map((session) => row(session, input.now, false))))
        .join("")
    : `<p class="quiet">No recent sessions.</p>`

  const warning = input.partial ? `<p class="warn">Some session data is unavailable.</p>` : ""

  const inbox = (input.inbox ?? []).length
    ? section("Needs input", (input.inbox ?? []).map(inboxRow))
    : ""

  const relay = renderRelayNotice({ digests: input.relay ?? [] })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Sessions</title>
<style>
${STYLE}
</style>
</head>
<body>
<h1>Sessions</h1>
${warning}
${inbox}
${running}
${groups}
${relay}
</body>
</html>`
}

// A plain form, not the browser's Basic prompt: password managers offer to
// save credentials submitted from a form with autocomplete fields, while
// HTTP Basic prompts are never offered for saving on phones.
export function renderLogin(input: { next: string; error?: string }) {
  const error = input.error ? `<p class="warn">${escapeHtml(input.error)}</p>` : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Sign in</title>
<style>
${STYLE}
label { display: block; font-size: 13px; color: #777; margin: 16px 0 6px }
input {
  width: 100%;
  padding: 12px;
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  background: #fff;
  color: inherit;
  font-size: 16px;
  font-family: inherit;
}
button {
  width: 100%;
  min-height: 48px;
  margin-top: 20px;
  border: 0;
  border-radius: 12px;
  background: #111;
  color: #fff;
  font-size: 16px;
  font-weight: 500;
}
@media (prefers-color-scheme: dark) {
  input { background: #1c1c1c; border-color: #333; color: #eee }
  button { background: #eee; color: #111 }
}
</style>
</head>
<body>
<h1>Sign in</h1>
${error}
<form method="POST" action="/login">
<label for="username">Username</label>
<input id="username" name="username" type="text" value="opencode" autocomplete="username" autocapitalize="none" autocorrect="off" required>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<input type="hidden" name="next" value="${escapeHtml(input.next)}">
<button type="submit">Sign in</button>
</form>
</body>
</html>`
}

export function renderUnreachable() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Sessions</title>
<style>
${STYLE}
</style>
</head>
<body>
<h1>Sessions</h1>
<p class="warn">The opencode server is unreachable.</p>
<p><a class="row" href="/m">Reload</a></p>
</body>
</html>`
}

export function renderUnauthorized() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Sessions</title>
<style>
${STYLE}
</style>
</head>
<body>
<h1>Sessions</h1>
<p class="warn">The opencode server rejected the gateway's password. Check that OPENCODE_SERVER_PASSWORD matches the running server; the desktop app generates a new password each launch.</p>
<p><a class="row" href="/m">Reload</a></p>
</body>
</html>`
}

// Relay digests are notify-only: rows are plain divs with no href, because
// approval always happens on the origin computer over its own gateway. The
// section carries the originID plus session metadata only — never secrets.
export function renderRelayNotice(input: { digests: RelayDigest[] }) {
  if (!input.digests.length) return ""
  return input.digests
    .map((digest) => {
      const rows = digest.items
        .map((item) => {
          const label = item.kind === "permission" ? "Approval needed" : "Question waiting"
          return `<div class="row"><span class="title">${escapeHtml(item.title)}</span><span class="meta">${escapeHtml(label)}</span></div>`
        })
        .join("")
      return `<section><h2>${escapeHtml(`Chats on ${digest.originID} need input`)}</h2>${rows}<p class="quiet">Open the Away address from Settings &gt; Servers to approve.</p></section>`
    })
    .join("")
}

const STYLE = `:root { color-scheme: light dark }
* { box-sizing: border-box }
body {
  margin: 0;
  font: 17px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #fafafa;
  color: #111;
  padding: max(env(safe-area-inset-top), 12px) 16px max(env(safe-area-inset-bottom), 24px) 16px;
}
h1 { font-size: 22px; margin: 8px 0 20px }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #666; margin: 24px 0 8px }
.row {
  display: block;
  min-height: 44px;
  padding: 14px 12px;
  margin-bottom: 8px;
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  background: #fff;
  color: inherit;
  text-decoration: none;
}
.title { display: block; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.meta { display: block; font-size: 13px; color: #777; margin-top: 4px }
.row-link { display: block; color: inherit; text-decoration: none }
.tasks { margin-top: 10px; font-size: 13px }
.tasks summary { color: #666; cursor: pointer }
.tasks ul { margin: 8px 0 0; padding: 0; list-style: none }
.tasks li {
  padding: 6px 2px;
  border-top: 1px solid #e5e5e5;
  font-size: 15px;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tasks li.completed, .tasks li.cancelled { color: #999; text-decoration: line-through }
.tasks li.in_progress { font-weight: 500 }
.quiet { color: #777; font-size: 15px }
.warn { background: #fff3cd; color: #664d03; padding: 10px 12px; border-radius: 10px; font-size: 14px }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #eee }
  .row { background: #1c1c1c; border-color: #333 }
  .meta, .quiet { color: #999 }
  .tasks summary { color: #999 }
  .tasks li { border-color: #333; color: #ddd }
  .tasks li.completed, .tasks li.cancelled { color: #777 }
  h2 { color: #999 }
  .warn { background: #3a2f00; color: #ffd76e }
}`