import { describe, expect, test } from "bun:test"
import type { Part } from "@flynncode/sdk/v2"
import {
  APPROVE_ACCEPT_EDITS,
  APPROVE_MANUAL,
  KEEP_PLANNING,
  claimPlanTool,
  nextPlanAgent,
  planAnswer,
  planChoiceFromLabel,
  planFromQuestion,
  planToolOutcome,
} from "@/context/plan-mode"

describe("planToolOutcome", () => {
  test("an approved exit switches to build and takes the chosen approval mode", () => {
    expect(
      planToolOutcome("exit_plan_mode", { approved: true, approval: "accept-edits", planPath: "/p" }, "manual"),
    ).toEqual({ agent: "build", approval: "accept-edits" })
    expect(
      planToolOutcome("exit_plan_mode", { approved: true, approval: "manual", planPath: "/p" }, "accept-edits"),
    ).toEqual({ agent: "build", approval: "manual" })
  })

  test("auto approval mode is kept after an approved exit", () => {
    expect(planToolOutcome("exit_plan_mode", { approved: true, approval: "manual", planPath: "/p" }, "auto")).toEqual({
      agent: "build",
      approval: "auto",
    })
  })

  test("an exit that was not approved changes nothing", () => {
    expect(planToolOutcome("exit_plan_mode", { approved: false, planPath: "/p" }, "manual")).toBeUndefined()
    expect(planToolOutcome("exit_plan_mode", undefined, "manual")).toBeUndefined()
    expect(planToolOutcome("exit_plan_mode", { approved: true, approval: "bogus" }, "manual")).toBeUndefined()
  })

  test("entering plan mode switches to plan and leaves the approval mode alone", () => {
    expect(planToolOutcome("enter_plan_mode", { mode: "plan", previousAgent: "build" }, "auto")).toEqual({
      agent: "plan",
    })
  })

  test("other tools are ignored", () => {
    expect(planToolOutcome("bash", { approved: true, approval: "manual" }, "manual")).toBeUndefined()
  })
})

describe("nextPlanAgent", () => {
  test("cycles build to plan to build", () => {
    expect(nextPlanAgent("build")).toBe("plan")
    expect(nextPlanAgent("plan")).toBe("build")
  })

  test("any other agent goes to plan, and no agent goes to plan", () => {
    expect(nextPlanAgent("custom")).toBe("plan")
    expect(nextPlanAgent(undefined)).toBe("plan")
  })
})

describe("claimPlanTool", () => {
  test("claims a part once", () => {
    const seen = new Set<string>()
    expect(claimPlanTool(seen, "prt_1")).toBe(true)
    expect(claimPlanTool(seen, "prt_1")).toBe(false)
    expect(claimPlanTool(seen, "prt_2")).toBe(true)
  })
})

describe("plan answers", () => {
  test("labels map to choices", () => {
    expect(planChoiceFromLabel(APPROVE_ACCEPT_EDITS)).toBe("accept-edits")
    expect(planChoiceFromLabel(APPROVE_MANUAL)).toBe("manual")
    expect(planChoiceFromLabel(KEEP_PLANNING)).toBe("keep")
    expect(planChoiceFromLabel("some feedback")).toBe("keep")
  })

  test("approvals answer with the exact option label", () => {
    expect(planAnswer("accept-edits", "ignored")).toEqual([[APPROVE_ACCEPT_EDITS]])
    expect(planAnswer("manual", "")).toEqual([[APPROVE_MANUAL]])
  })

  test("keep planning sends the trimmed feedback, or the label when there is none", () => {
    expect(planAnswer("keep", "  split step 2  ")).toEqual([["split step 2"]])
    expect(planAnswer("keep", "   ")).toEqual([[KEEP_PLANNING]])
  })
})

describe("planFromQuestion", () => {
  const tool = (callID: string, name: string, input: Record<string, unknown>): Part =>
    ({
      id: `prt_${callID}`,
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID,
      tool: name,
      state: { status: "running", input, time: { start: 1 } },
    }) as Part

  test("returns the plan of the exit_plan_mode call the question belongs to", () => {
    const parts = [tool("c1", "bash", { plan: "no" }), tool("c2", "exit_plan_mode", { plan: "# Plan\n- a" })]
    expect(planFromQuestion({ messageID: "msg_1", callID: "c2" }, parts)).toBe("# Plan\n- a")
  })

  test("ignores questions from other tools or without a tool reference", () => {
    const parts = [tool("c1", "question", { plan: "x" })]
    expect(planFromQuestion({ messageID: "msg_1", callID: "c1" }, parts)).toBeUndefined()
    expect(planFromQuestion(undefined, parts)).toBeUndefined()
    expect(planFromQuestion({ messageID: "msg_1", callID: "c1" }, undefined)).toBeUndefined()
  })

  test("a plan call without plan text is still recognised", () => {
    const parts = [tool("c1", "exit_plan_mode", {})]
    expect(planFromQuestion({ messageID: "msg_1", callID: "c1" }, parts)).toBe("")
  })
})
