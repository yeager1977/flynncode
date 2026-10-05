import { describe, expect, test } from "bun:test"
import { previewFromConfig, previewToConfig } from "./preview-payload"

describe("preview-payload", () => {
  test("reads an absent object as no servers and default autoVerify", () => {
    expect(previewFromConfig({})).toEqual({ servers: [], autoVerify: true })
  })

  test("autoVerify false survives the round trip", () => {
    const config = { preview: { servers: [{ name: "web", command: "bun dev" }], autoVerify: false } } as never
    const form = previewFromConfig(config)
    expect(form.autoVerify).toBe(false)
    const written = previewToConfig(form)
    expect(previewFromConfig(written as never).autoVerify).toBe(false)
  })

  test("passes configured servers through and drops unnamed entries", () => {
    const form = previewFromConfig({
      preview: { servers: [{ name: "web", command: "bun dev" }, { name: "", command: "x" }] },
    } as never)
    expect(previewToConfig(form).preview?.servers).toEqual([{ name: "web", command: "bun dev" }])
  })
})