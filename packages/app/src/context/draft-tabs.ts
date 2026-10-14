import { sessionHref } from "@/utils/session-route"
import type { DraftTab, SessionTab, Tab } from "./tabs"

// Sessions have no tabs: the sidebar routes to them. The tab store only keeps
// the hidden drafts behind /new-session?draftId=…

// A draft whose first prompt created a session goes away; the session route
// replaces it.
export function promoteDraft(tabs: Tab[], draftID: string, session: Omit<SessionTab, "type">) {
  return {
    tabs: tabs.filter((tab) => !(tab.type === "draft" && tab.draftID === draftID)),
    href: sessionHref(session.server, session.sessionId),
  }
}

// On each route change: the last non-Home route (where the Home toggle
// returns) and the drafts to drop because they were never used and are
// neither shown nor that return target.
export function draftRouteChange(input: {
  path: string
  back: string | undefined
  tabs: Tab[]
  unused: (draft: DraftTab) => boolean
}) {
  const back = new URL(input.path, "http://route").pathname === "/" ? input.back : input.path
  const keep = new Set([routeDraftID(input.path), routeDraftID(back)])
  return {
    back,
    prune: input.tabs.flatMap((tab) =>
      tab.type === "draft" && !keep.has(tab.draftID) && input.unused(tab) ? [tab.draftID] : [],
    ),
  }
}

// A draft counts as never used only once its persisted prompt has loaded and
// holds neither text nor attached context; one without prompt state in memory
// (not visited this run) is kept.
export function unusedDraftPrompt(
  prompt: { ready: () => boolean; dirty: () => boolean; context: { items: () => readonly unknown[] } } | undefined,
) {
  return !!prompt && prompt.ready() && !prompt.dirty() && prompt.context.items().length === 0
}

function routeDraftID(path: string | undefined) {
  if (!path) return
  const url = new URL(path, "http://route")
  if (url.pathname !== "/new-session") return
  return url.searchParams.get("draftId") ?? undefined
}
