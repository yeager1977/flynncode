import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { ImportedMessage } from "@opencode-ai/protocol/groups/import"

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