import type { Part } from "@flynncode/sdk/v2"
import type { ApprovalMode } from "./permission-auto-respond"

export const PLAN_AGENT = "plan"
export const BUILD_AGENT = "build"

// The labels are the contract with the exit_plan_mode tool in packages/flynncode/src/tool/plan.ts.
export const APPROVE_ACCEPT_EDITS = "Approve — auto-accept edits"
export const APPROVE_MANUAL = "Approve — ask for each edit"
export const KEEP_PLANNING = "Keep planning"

export type PlanChoice = "accept-edits" | "manual" | "keep"

export type PlanOutcome = { agent: string; approval?: ApprovalMode }

// What the client does once a plan tool call completes. An approved plan hands the session to build with the
// approval mode the user picked, but an explicit "auto" mode is the user's broader choice and stays.
export function planToolOutcome(
  tool: string,
  metadata: Record<string, unknown> | undefined,
  current: ApprovalMode,
): PlanOutcome | undefined {
  if (tool === "enter_plan_mode") return { agent: PLAN_AGENT }
  if (tool !== "exit_plan_mode") return
  if (metadata?.approved !== true) return
  if (metadata.approval !== "accept-edits" && metadata.approval !== "manual") return
  return { agent: BUILD_AGENT, approval: current === "auto" ? "auto" : metadata.approval }
}

export function nextPlanAgent(current: string | undefined) {
  return current === PLAN_AGENT ? BUILD_AGENT : PLAN_AGENT
}

// True the first time a tool part is seen, so a repeated update of the same completed call reacts once.
export function claimPlanTool(seen: Set<string>, partID: string) {
  if (seen.has(partID)) return false
  seen.add(partID)
  return true
}

export function planChoiceFromLabel(label: string): PlanChoice {
  if (label === APPROVE_ACCEPT_EDITS) return "accept-edits"
  if (label === APPROVE_MANUAL) return "manual"
  return "keep"
}

export function planAnswer(choice: PlanChoice, feedback: string) {
  if (choice === "accept-edits") return [[APPROVE_ACCEPT_EDITS]]
  if (choice === "manual") return [[APPROVE_MANUAL]]
  // Free text is the "keep planning" answer carrying feedback.
  return [[feedback.trim() || KEEP_PLANNING]]
}

// The plan markdown of the exit_plan_mode call a pending question belongs to.
export function planFromQuestion(tool: { callID: string } | undefined, parts: readonly Part[] | undefined) {
  if (!tool) return
  const part = parts?.find((item) => item.type === "tool" && item.callID === tool.callID)
  if (part?.type !== "tool" || part.tool !== "exit_plan_mode") return
  const plan = part.state.input.plan
  return typeof plan === "string" ? plan : ""
}
