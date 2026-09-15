import { describe, expect, test } from "bun:test"
import plugin from "../index"

describe("scaffold", () => {
  test("exports the plugin shape the loader requires", () => {
    expect(plugin.id).toBe("ollama-model-router")
    expect(typeof plugin.server).toBe("function")
  })
})
