import { type ParentProps } from "solid-js"
import { createSimpleContext } from "@flynncode/ui/context"
import { createSideChatController } from "./session-side-chat-controller"

export const { use: useSideChat, provider: SideChatProvider } = createSimpleContext({
  name: "SideChat",
  gate: false,
  init: () => createSideChatController(),
})