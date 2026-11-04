import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@flynncode/core/util/encode"
import { currentSession } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const serverA = "http://127.0.0.1:4096"
const serverB = "http://127.0.0.1:4097"
const sessionA = session("ses_server_a", "C:/server-a", "Server A session")
const sessionB = session("ses_server_b", "/home/server-b", "Server B session")

// Sessions have no tabs to close, so a remote session is reached by its server-keyed route alone.
test("a session on another server loads only from that server", async ({ page }) => {
  const requests: string[] = []
  await mockServers(page, requests)
  await configureServers(page)

  // Server A is the app's active server; the route names server B's session.
  await page.goto(sessionHref(serverB, sessionB.id))
  await expectSessionTitle(page, sessionB.title)

  await expect.poll(() => requests.some((url) => url.startsWith(`${serverB}/api/session/${sessionB.id}`))).toBe(true)
  const sessionBRequests = requests.filter((url) => url.includes(`/session/${sessionB.id}`))
  expect(sessionBRequests.every((url) => url.startsWith(serverB))).toBe(true)
  expect(
    requests.some((request) => {
      const url = new URL(request)
      return url.origin === serverB && url.searchParams.get("directory") === sessionB.directory
    }),
  ).toBe(true)
})

// A legacy `/:dir/session/:id` link names no server. Persisted session tabs used to pick one, but they are purged on
// load now (nothing creates them), so the link opens on the active server.
test("legacy session routes open the session on the active server", async ({ page }) => {
  await mockServers(page, [])
  await configureServers(page)

  await page.goto(`/${base64Encode(sessionA.directory)}/session/${sessionA.id}`)
  await expect(page).toHaveURL(sessionHref(serverA, sessionA.id))
  await expectSessionTitle(page, sessionA.title)
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
  await page.addInitScript((serverB) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: [serverB] }))
  }, serverB)
}

async function mockServers(page: Page, requests: string[]) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== serverA && url.origin !== serverB) return route.fallback()
    requests.push(url.toString())
    const current = url.origin === serverA ? sessionA : sessionB
    const directory = url.searchParams.get("directory")
    if (directory && directory !== current.directory) return json(route, { name: "InvalidDirectory" }, 500)
    if (url.pathname === "/global/event" || url.pathname === "/event" || url.pathname === "/api/event")
      return sse(route)
    if (url.pathname === "/global/health") return json(route, {}, 404)
    if (url.pathname === "/api/health") return json(route, { pid: 1 })
    if (url.pathname === "/api/session") return json(route, { data: [currentSession(current)], cursor: {} })
    if (url.pathname === "/api/session/active") return json(route, { data: {} })
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

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
}
