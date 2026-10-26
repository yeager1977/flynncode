import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@flynncode/sdk/v2"
import { latestToolCall } from "./latest-tool-call"

describe("latestToolCall", () => {
  test("finds the most recent call of a tool across messages", () => {
    const messages = [message("m1"), message("m2"), message("m3")]
    const parts = {
      m1: [tool("m1", "c1", "enter_plan_mode")],
      m2: [tool("m2", "c2", "read"), tool("m2", "c3", "enter_plan_mode"), tool("m2", "c4", "exit_plan_mode")],
      m3: [tool("m3", "c5", "bash")],
    }
    expect(latestToolCall(messages, parts, "enter_plan_mode")).toBe("c3")
    expect(latestToolCall(messages, parts, "question")).toBeUndefined()
  })
})

function message(id: string): Message {
  return {
    id,
    sessionID: "ses",
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "p", modelID: "m" },
  }
}

function tool(messageID: string, callID: string, name: string): Part {
  return {
    id: `part_${callID}`,
    sessionID: "ses",
    messageID,
    type: "tool",
    callID,
    tool: name,
    state: { status: "completed", input: {}, output: "", title: name, metadata: {}, time: { start: 0, end: 1 } },
  }
}
