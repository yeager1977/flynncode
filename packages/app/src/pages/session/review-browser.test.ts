import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { previewDotClass, previewManaged } from "./preview-server"

describe("review browser preview-server dropdown wiring", () => {
  const source = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")

  test("renders a state dot and server dropdown in the pane header", () => {
    expect(source).toContain("DropdownMenu")
    expect(source).toContain('data-slot="preview-state-dot"')
    expect(source).toContain("previewDotClass")
    expect(source).toContain("language.t(\"preview.servers.menu\")")
  })

  test("wires lifecycle actions through the preview SDK", () => {
    expect(source).toContain("client.preview.servers.list")
    expect(source).toContain('client.preview.servers[action]')
    expect(source).toContain("previewStartPayload: { name: server.name }")
    expect(source).toContain('preview.error.actionFailed')
  })

  test("attach-only servers open their URL instead of lifecycle actions", () => {
    expect(source).toContain("openAttachUrl")
    expect(source).toContain("previewManaged")
    expect(source).toContain("platform.openExternal")
  })

  test("edit config opens the settings dialog on the preview tab", () => {
    expect(source).toContain('defaultValue="preview"')
    expect(source).toContain('language.t("preview.action.editConfig")')
  })

  test("server actions surface errors inline without toasts", () => {
    expect(source).toContain("actionError")
    expect(source).not.toContain("showToast")
  })
})

describe("preview-server helpers", () => {
  test("state-dot classes come from design tokens", () => {
    expect(previewDotClass("running")).toBe("bg-icon-success-base")
    expect(previewDotClass("starting")).toBe("bg-icon-warning-base")
    expect(previewDotClass("failed")).toBe("bg-icon-critical-base")
    expect(previewDotClass("stopped")).toBe("bg-icon-weak-base")
  })

  test("attach-only servers are not managed", () => {
    expect(previewManaged({ name: "a", state: "running", attach: true })).toBe(false)
    expect(previewManaged({ name: "a", state: "running" })).toBe(true)
  })

  test("error detail extraction reads the declared PreviewError body", async () => {
    const { previewErrorDetail } = await import("./preview-server")
    const apiError = { body: { name: "PreviewStartFailedError", data: { message: "cwd does not exist" } } }
    expect(previewErrorDetail(apiError)).toBe("cwd does not exist")
    expect(previewErrorDetail(new Error("boom"))).toBe("boom")
    expect(previewErrorDetail(undefined)).toBeUndefined()
  })
})

describe("browser pane docking", () => {
  const paneSource = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")

  test("URL bar normalizes input through the pane helpers", () => {
    expect(paneSource).toContain("normalizePreviewUrl")
    expect(paneSource).toContain("isLocalPreviewUrl")
  })

  test("pane exposes docked data-component with i18n title", () => {
    expect(paneSource).toContain('data-component="browser-pane"')
    expect(paneSource).toContain('language.t("session.review.browserPane.title")')
  })

  test("pane URL persists per session and mounts beside the diff", () => {
    expect(paneSource).toContain("browserPaneUrlFor")
    expect(paneSource).toContain("setBrowserPaneUrl")
    const panelSource = readFileSync(new URL("./v2/review-panel-v2.tsx", import.meta.url), "utf8")
    expect(panelSource).toContain("ReviewBrowser")
  })
})

describe("auto-verify affordance", () => {
  test("pane surfaces a verify control tied to the auto-verify setting", () => {
    const paneSource = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")
    expect(paneSource).toContain('language.t("session.review.browserPane.verify")')
  })
})

describe("point-mode annotation", () => {
  const paneSource = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")

  test("mark control offers a point mode", () => {
    expect(paneSource).toContain('data-action="mark-point"')
    expect(paneSource).toContain('language.t("session.review.markPoint")')
  })

  test("point mode skips the drag pass and records a zero-size percent rect", () => {
    expect(paneSource).toContain("if (state.point) return")
    expect(paneSource).toMatch(/width: 0, height: 0, marked: true/)
  })

  test("point mode label is registered in the i18n dictionaries", () => {
    expect(readFileSync(new URL("../../i18n/en.ts", import.meta.url), "utf8")).toContain('"session.review.markPoint"')
    expect(readFileSync(new URL("../../i18n/flynncode-fallback.ts", import.meta.url), "utf8")).toContain(
      '"session.review.markPoint"',
    )
  })
})

describe("native preview host wiring", () => {
  const paneSource = readFileSync(new URL("./review-browser.tsx", import.meta.url), "utf8")

  test("prefers the native host when the flag and desktop api exist", () => {
    expect(paneSource).toContain("window.api?.previewHost")
    expect(paneSource).toContain("nativeWanted")
    expect(paneSource).toContain("host.attach(state.loaded)")
  })

  test("any host failure tears the view down and returns to the iframe", () => {
    expect(paneSource).toContain('setState("native", false)')
    expect(paneSource).toContain("host.detach()")
    expect(paneSource).toContain("onHostTeardown")
  })
})

describe("auto-open on running preview", () => {
  const panelSource = readFileSync(new URL("./v2/review-panel-v2.tsx", import.meta.url), "utf8")

  test("browser pane auto-opens on a running preview server", () => {
    expect(panelSource).toContain("preview.servers.list")
    expect(panelSource).toContain('state === "running"')
    expect(panelSource).toContain("setBrowserOpen(true)")
  })

  test("auto-open respects a user-closed pane for the same session and URL", () => {
    expect(panelSource).toContain("dismissed")
    expect(panelSource).toContain("dismissedKey")
  })
})