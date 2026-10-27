import { describe, expect, test } from "bun:test"
import { McpDefer } from "@/mcp/defer"

const serverOf = (id: string) => id.split("_")[0]

const ids = (server: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${server}_tool${String(index).padStart(2, "0")}`)

const plan = (input: Partial<Parameters<typeof McpDefer.plan>[0]> & { tools: string[] }) =>
  McpDefer.plan({ servers: {}, serverOf, threshold: 15, loaded: new Set(), disabled: false, ...input })

describe("McpDefer.plan", () => {
  test("defers every tool above the threshold", () => {
    const tools = ids("a", 16)
    expect(plan({ tools })).toEqual({ sent: [], deferred: tools })
  })

  test("defers nothing at or below the threshold", () => {
    const tools = ids("a", 15)
    expect(plan({ tools })).toEqual({ sent: tools, deferred: [] })
  })

  test("defer true always defers, even below the threshold", () => {
    expect(plan({ tools: [...ids("a", 2), ...ids("b", 2)], servers: { b: { defer: true } } })).toEqual({
      sent: ids("a", 2),
      deferred: ids("b", 2),
    })
  })

  test("defer false keeps a server's tools sent above the threshold", () => {
    expect(plan({ tools: [...ids("a", 10), ...ids("b", 10)], servers: { a: { defer: false } } })).toEqual({
      sent: ids("a", 10),
      deferred: ids("b", 10),
    })
  })

  test("threshold zero defers everything", () => {
    const tools = ids("a", 1)
    expect(plan({ tools, threshold: 0 })).toEqual({ sent: [], deferred: tools })
  })

  test("disabled defers nothing, even with defer true", () => {
    const tools = ids("a", 20)
    expect(plan({ tools, servers: { a: { defer: true } }, disabled: true })).toEqual({ sent: tools, deferred: [] })
  })

  test("loaded ids are always sent", () => {
    const tools = ids("a", 16)
    expect(plan({ tools, loaded: new Set([tools[3], tools[1]]) })).toEqual({
      sent: [tools[1], tools[3]],
      deferred: tools.filter((id) => id !== tools[1] && id !== tools[3]),
    })
  })

  test("loaded ids that are not visible are ignored", () => {
    expect(plan({ tools: ids("a", 16), loaded: new Set(["gone_tool"]) }).sent).toEqual([])
  })

  test("outputs keep the input order", () => {
    const result = plan({ tools: ["b_z", "a_y", "b_a", "a_x"], threshold: 0, loaded: new Set(["b_a"]) })
    expect(result).toEqual({ sent: ["b_a"], deferred: ["b_z", "a_y", "a_x"] })
    expect(plan({ tools: ["b_z", "a_y", "b_a"] })).toEqual({ sent: ["b_z", "a_y", "b_a"], deferred: [] })
  })
})
