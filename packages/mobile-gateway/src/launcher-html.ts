import { projectLabel, relativeTime, sessionSlug, type LauncherData, type LauncherSession } from "./launcher.ts"

const RUNNING_BADGE = "running"
const SUBAGENT_BADGE = "subagent"

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function row(session: LauncherSession, now: number, running: boolean) {
  const title = `<span class="title">${escapeHtml(session.title)}</span>`
  const badges = `${running ? ` &middot; ${RUNNING_BADGE}` : ""}${session.subagent ? ` &middot; ${SUBAGENT_BADGE}` : ""}`
  // A placeholder session (running but outside the recent window) has no known update
  // time; showing "20000d ago" would be worse than showing nothing.
  const when = session.updated > 0 ? ` &middot; ${escapeHtml(relativeTime(session.updated, now))}` : ""
  const meta = `<span class="meta">${escapeHtml(projectLabel(session.directory))}${when}${badges}</span>`
  if (session.directory === undefined) return `<div class="row">${title}${meta}</div>`
  const href = `/${sessionSlug(session.directory)}/session/${encodeURIComponent(session.id)}`
  return `<a class="row" href="${escapeHtml(href)}">${title}${meta}</a>`
}

function section(heading: string, rows: string[]) {
  return `<section><h2>${escapeHtml(heading)}</h2>${rows.join("")}</section>`
}

export function renderLauncher(input: { data: LauncherData; now: number; partial: boolean }) {
  const running = input.data.running.length
    ? section("Running now", input.data.running.map((session) => row(session, input.now, true)))
    : `<p class="quiet">Nothing is running.</p>`

  const groups = input.data.groups.length
    ? input.data.groups
        .map((group) => section(group.label, group.sessions.map((session) => row(session, input.now, false))))
        .join("")
    : `<p class="quiet">No recent sessions.</p>`

  const warning = input.partial ? `<p class="warn">Some session data is unavailable.</p>` : ""

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
${running}
${groups}
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
.quiet { color: #777; font-size: 15px }
.warn { background: #fff3cd; color: #664d03; padding: 10px 12px; border-radius: 10px; font-size: 14px }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #eee }
  .row { background: #1c1c1c; border-color: #333 }
  .meta, .quiet { color: #999 }
  h2 { color: #999 }
  .warn { background: #3a2f00; color: #ffd76e }
}`