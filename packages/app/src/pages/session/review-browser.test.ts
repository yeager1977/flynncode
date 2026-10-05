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