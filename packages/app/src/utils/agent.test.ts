import { describe, expect, test } from "bun:test"
import { commonAgent } from "./agent"

describe("commonAgent", () => {
  test("reports the agent most of the sessions used", () => {
    const sessions = [{ agent: "build" }, { agent: "build" }, { agent: "plan" }]

    expect(commonAgent(sessions)).toBe("build")
  })

  test("ignores sessions without an agent", () => {
    const sessions = [{ agent: "plan" }, {}, { agent: "plan" }]

    expect(commonAgent(sessions)).toBe("plan")
  })

  test("returns undefined when no session names an agent", () => {
    expect(commonAgent([{}, {}])).toBeUndefined()
    expect(commonAgent([])).toBeUndefined()
  })
})
