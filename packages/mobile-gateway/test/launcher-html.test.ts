import { describe, expect, test } from "bun:test"
import { escapeHtml, renderLauncher, renderUnauthorized, renderUnreachable } from "../src/launcher-html.ts"

const NOW = 1_700_000_000_000

const data = (overrides: Partial<{ running: never[]; groups: never[] }> = {}) => ({
  running: [],
  groups: [],
  ...overrides,
})

describe("escapeHtml", () => {
  test("escapes markup characters", () => {
    expect(escapeHtml(`<script>alert("x")&'y'</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;",
    )
  })
})

describe("renderLauncher", () => {
  test("renders a session as a deep link with an escaped title", () => {
    const html = renderLauncher({
      now: NOW,
      partial: false,
      data: {
        running: [],
        groups: [
          {
            directory: "/work/flynncode",
            label: "flynncode",
            sessions: [
              { id: "ses_1", title: "<img src=x onerror=alert(1)>", directory: "/work/flynncode", updated: NOW - 60_000, subagent: false },
            ],
          },
        ],
      },
    })
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain(`/L3dvcmsvZmx5bm5jb2Rl/session/ses_1`)
    expect(html).toContain("1m ago")
    expect(html).toContain("flynncode")
  })

  test("marks running sessions and excludes them from groups", () => {
    const html = renderLauncher({
      now: NOW,
      partial: false,
      data: {
        running: [
          { id: "ses_run", title: "Working", directory: "/work/a", updated: NOW - 1_000, subagent: false },
        ],
        groups: [],
      },
    })
    expect(html).toContain("Running now")
    expect(html).toContain("Working")
    expect(html).toContain("just now")
  })

  test("states when nothing is running", () => {
    const html = renderLauncher({ now: NOW, partial: false, data: data() })
    expect(html).toContain("Nothing is running")
  })

  test("states when there are no recent sessions", () => {
    const html = renderLauncher({ now: NOW, partial: false, data: data() })
    expect(html).toContain("No recent sessions")
  })

  test("renders a session without a directory as text, not a link", () => {
    const html = renderLauncher({
      now: NOW,
      partial: false,
      data: {
        running: [{ id: "ses_orphan123", title: "ses_orphan12", directory: undefined, updated: 0, subagent: false }],
        groups: [],
      },
    })
    expect(html).toContain("ses_orphan12")
    expect(html).not.toContain("/session/ses_orphan123")
  })

  test("warns when data is partial", () => {
    const html = renderLauncher({ now: NOW, partial: true, data: data() })
    expect(html).toContain("Some session data is unavailable")
  })

  test("omits the warning when data is complete", () => {
    const html = renderLauncher({ now: NOW, partial: false, data: data() })
    expect(html).not.toContain("Some session data is unavailable")
  })

  test("labels a running subagent so the dead end is visible before tapping", () => {
    const html = renderLauncher({
      now: NOW,
      partial: false,
      data: {
        running: [{ id: "ses_child1", title: "Child work", directory: "/work/a", updated: NOW - 1_000, subagent: true }],
        groups: [],
      },
    })
    expect(html).toContain("subagent")
    expect(html).toContain("running")
  })

  test("omits the timestamp for a placeholder session with no known update time", () => {
    const html = renderLauncher({
      now: NOW,
      partial: true,
      data: {
        running: [{ id: "ses_orphan1", title: "ses_orphan1", directory: undefined, updated: 0, subagent: false }],
        groups: [],
      },
    })
    expect(html).not.toMatch(/\d+d ago/)
    expect(html).not.toMatch(/\d+h ago/)
    expect(html).toContain("running")
  })

  test("does not label a main session as a subagent", () => {
    const html = renderLauncher({
      now: NOW,
      partial: false,
      data: {
        running: [{ id: "ses_main1", title: "Main work", directory: "/work/a", updated: NOW - 1_000, subagent: false }],
        groups: [],
      },
    })
    expect(html).not.toContain("subagent")
  })

  test("declares mobile install metadata and no scripts", () => {
    const html = renderLauncher({ now: NOW, partial: false, data: data() })
    expect(html).toContain("apple-mobile-web-app-capable")
    expect(html).toContain("viewport-fit=cover")
    expect(html).toContain("safe-area-inset-bottom")
    expect(html).not.toContain("<script")
  })
})

describe("renderUnreachable", () => {
  test("explains the server is unreachable and offers a reload", () => {
    const html = renderUnreachable()
    expect(html).toContain("unreachable")
    expect(html).toContain('href="/m"')
  })
})

describe("renderUnauthorized", () => {
  test("explains the upstream credential was rejected", () => {
    const html = renderUnauthorized()
    expect(html).toContain("OPENCODE_SERVER_PASSWORD")
  })

  test("offers a reload link", () => {
    const html = renderUnauthorized()
    expect(html).toContain('href="/m"')
  })

  test("contains no scripts", () => {
    const html = renderUnauthorized()
    expect(html).not.toContain("<script")
  })
})