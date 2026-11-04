import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@flynncode/core/util/encode"
import { currentSession } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const serverA = "http://127.0.0.1:4096"
const serverB = "http://127.0.0.1:4097"
const sessionA = session("ses_server_a", "C:/server-a", "Server A session")
const sessionB = session("ses_server_b", "/home/server-b", "Server B session")

// Sessions have no tabs, so the busy state a session shows is the one on its own page: the prompt's Stop button.
test("a session is busy only when its own server reports it running", async ({ page }) => {
  await mockServers(page)
  await configureServers(page)

  // Session B is running on server B while server A, the app's active server, is idle. The page must take its busy
  // state from the server of its route, not from the active server.
  await page.goto(sessionHref(serverB, sessionB.id))
  await expectSessionTitle(page, sessionB.title)
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()

  // Session A is idle on server A. Server B still reports session B running, and that must not reach session A.
  await page
    .getByRole("navigation", { name: "Projects and sessions" })
    .getByRole("link", { name: sessionA.title, exact: true })
    .click()
  await expect(page).toHaveURL(sessionHref(serverA, sessionA.id))
  await expectSessionTitle(page, sessionA.title)
  await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0)
})

function session(id: string, directory: string, title: string) {
  return {
    id,
    slug: id,
    projectID: `project-${id}`,
    directory,
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}

function sessionHref(server: string, sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

async function configureServers(page: Page) {
  await page.addInitScript(
    ({ directoryA, serverB }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      // Server B is a remote server; the app's own server (A) is the "local" scope, whose open project the sidebar lists.
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [serverB],
          projects: { local: [{ worktree: directoryA, expanded: true }] },
          lastProject: { local: directoryA },
        }),
      )
    },
    { directoryA: sessionA.directory, serverB },
  )
}

async function mockServers(page: Page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== serverA && url.origin !== serverB) return route.fallback()
    const remote = url.origin === serverB
    const current = remote ? sessionB : sessionA
    const directory = url.searchParams.get("directory")
    if (directory && directory !== current.directory) return json(route, { name: "InvalidDirectory" }, 500)
    if (url.pathname === "/global/event" || url.pathname === "/event" || url.pathname === "/api/event")
      return sse(route, url.pathname === "/api/event")
    if (url.pathname === "/global/health") return json(route, {}, 404)
    if (url.pathname === "/api/health") return json(route, { pid: 1 })
    if (url.pathname === "/api/session/active")
      return json(route, { data: remote ? { [sessionB.id]: { type: "running" } } : {} })
    if (url.pathname === "/api/session") return json(route, { data: [currentSession(current)], cursor: {} })
    if (url.pathname === `/api/session/${current.id}`) return json(route, { data: currentSession(current) })
    if (url.pathname === `/api/session/${current.id}/message`) return json(route, { data: [], cursor: {} })
    if (url.pathname === `/session/${current.id}`) return json(route, current)
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(route, { name: "NotFoundError" }, 404)
    if (url.pathname === `/session/${current.id}/message`) return json(route, [])
    if (/^\/session\/[^/]+\/(children|todo|diff|shells|schedules)$/.test(url.pathname)) return json(route, [])
    if (
      ["/skill", "/command", "/lsp", "/formatter", "/permission", "/question", "/vcs/diff", "/pty/shells"].includes(
        url.pathname,
      )
    )
      return json(route, [])
    if (["/global/config", "/config", "/provider/auth", "/mcp"].includes(url.pathname)) return json(route, {})
    if (url.pathname === "/provider" || url.pathname === "/provider/connected")
      return json(route, { all: [], connected: [], default: { providerID: "", modelID: "" } })
    if (url.pathname === "/api/provider" || url.pathname === "/api/model" || url.pathname === "/api/agent")
      return json(route, { data: [] })
    if (url.pathname === "/api/model/default") return json(route, { data: null })
    if (["/api/command", "/api/reference", "/api/permission/request", "/api/question/request"].includes(url.pathname))
      return json(route, { location: { directory: current.directory }, data: [] })
    if (url.pathname === "/api/mcp") return json(route, { location: { directory: current.directory }, data: [] })
    if (url.pathname === "/api/mcp/resource")
      return json(route, { location: { directory: current.directory }, data: { resources: [], templates: [] } })
    if (url.pathname === "/api/pty/shells") return json(route, { location: { directory: current.directory }, data: [] })
    if (url.pathname === "/agent") return json(route, [{ name: "build", mode: "primary" }])
    if (url.pathname === "/project" || url.pathname === "/project/current" || url.pathname === "/api/project") {
      const project = {
        id: current.projectID,
        worktree: current.directory,
        vcs: "git",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      }
      return json(route, url.pathname === "/project/current" ? project : [project])
    }
    if (url.pathname === "/api/project/current")
      return json(route, { id: current.projectID, directory: current.directory })
    if (url.pathname === "/path" || url.pathname === "/api/path")
      return json(route, {
        state: current.directory,
        config: current.directory,
        worktree: current.directory,
        directory: current.directory,
        home: current.directory,
      })
    if (url.pathname === "/vcs") return json(route, { branch: "main", default_branch: "main" })
    if (url.pathname === "/api/vcs")
      return json(route, {
        location: { directory: current.directory },
        data: { branch: "main", defaultBranch: "main" },
      })
    return json(route, {})
  })
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function sse(route: Route, current: boolean) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: current ? 'data: {"id":"evt_connected","type":"server.connected","data":{}}\n\n' : ": ok\n\n",
  })
}
