import { makeEventListener } from "@solid-primitives/event-listener"
import { onMount } from "solid-js"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "@/pages/layout/deep-links"

// The desktop forwards opencode:// URLs as a window event, or queues them on
// window.__OPENCODE__ before the renderer is ready. Only the retired legacy
// layout listened, so the new layout dropped every link.
export function DeepLinkListener() {
  const layout = useLayout()
  const server = useServer()
  const tabs = useTabs()

  const handle = (urls: string[]) => {
    if (!server.isLocal()) return
    for (const directory of collectOpenProjectDeepLinks(urls)) {
      layout.projects.open(directory)
      void tabs.newDraft({ server: server.key, directory })
    }
    for (const link of collectNewSessionDeepLinks(urls)) {
      layout.projects.open(link.directory)
      void tabs.newDraft({ server: server.key, directory: link.directory }, link.prompt)
    }
  }

  onMount(() => handle(drainPendingDeepLinks(window)))
  makeEventListener(window, deepLinkEvent, (event) => {
    handle((event as CustomEvent<{ urls?: string[] }>).detail?.urls ?? [])
  })

  return null
}
