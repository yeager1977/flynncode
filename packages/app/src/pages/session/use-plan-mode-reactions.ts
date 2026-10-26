import { onCleanup } from "solid-js"
import { useLocal } from "@/context/local"
import { claimPlanTool, planToolOutcome } from "@/context/plan-mode"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "./session-layout"

// Reacts to live plan tool completions only: history loaded from the server never goes through the event
// stream, so reopening an old session does not flip its agent.
export function usePlanModeReactions() {
  const sdk = useSDK()
  const local = useLocal()
  const permission = usePermission()
  const { params } = useSessionLayout()
  const seen = new Set<string>()

  onCleanup(
    sdk().event.on("message.part.updated", (evt) => {
      const part = evt.properties.part
      if (part.type !== "tool") return
      if (part.sessionID !== params.id) return
      if (part.state.status !== "completed") return

      const outcome = planToolOutcome(
        part.tool,
        part.state.metadata,
        permission.approvalMode(part.sessionID, sdk().directory),
      )
      if (!outcome) return
      if (!claimPlanTool(seen, part.id)) return

      local.agent.set(outcome.agent)
      if (outcome.approval) permission.setApprovalMode(part.sessionID, sdk().directory, outcome.approval)
    }),
  )
}
