import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { ImportedMessage, makeImportGroup } from "@opencode-ai/protocol/groups/import"

const decode = Schema.decodeUnknownSync(ImportedMessage)

describe("ImportedMessage", () => {
  it("accepts user and assistant text", () => {
    expect(decode({ role: "user", text: "hi", time: 1 })).toEqual({ role: "user", text: "hi", time: 1 })
    expect(decode({ role: "assistant", text: "yo", time: 2 })).toEqual({ role: "assistant", text: "yo", time: 2 })
  })

  it("rejects unknown roles and missing text", () => {
    expect(() => decode({ role: "system", text: "x", time: 1 })).toThrow()
    expect(() => decode({ role: "user", time: 1 })).toThrow()
  })

  it("rejects negative timestamps", () => {
    expect(() => decode({ role: "user", text: "x", time: -1 })).toThrow()
  })
})

describe("import group routes", () => {
  const spec = OpenApi.fromApi(HttpApi.make("import-test").add(makeImportGroup())) as {
    paths: Record<string, Record<string, { operationId?: string }>>
  }

  it("exposes import.sources", () => {
    expect(spec.paths["/api/import/sources"]?.get?.operationId).toBe("v2.import.sources")
  })

  it("exposes import.fromSource", () => {
    expect(spec.paths["/api/import/from-source"]?.post?.operationId).toBe("v2.import.fromSource")
  })
})