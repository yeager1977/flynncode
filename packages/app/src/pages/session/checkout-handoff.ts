export type CheckoutRef = {
  directory: string
  branch?: string
}

// `targets` lists every destination the user may pick; `create` means there
// is no other worktree yet, so confirming creates one.
export type HandoffDecision =
  | { ok: true; targets: string[]; create: boolean }
  | { ok: false; reason: "not-git" | "occupied" }

export function checkoutHandoff(input: {
  current: string
  primary: string
  branch?: string
  worktrees: readonly CheckoutRef[]
  git: boolean
}): HandoffDecision {
  if (!input.git) return { ok: false, reason: "not-git" }
  const onPrimary = input.current === input.primary
  const candidates = onPrimary
    ? input.worktrees.map((item) => item.directory).filter((directory) => directory !== input.primary)
    : [input.primary]
  const branch = input.branch
  const targets = branch
    ? candidates.filter((target) => !occupied(branch, input.current, target, input.worktrees))
    : candidates
  if (candidates.length > 0 && targets.length === 0) return { ok: false, reason: "occupied" }
  return { ok: true, targets, create: targets.length === 0 }
}

function occupied(branch: string, current: string, target: string | undefined, worktrees: readonly CheckoutRef[]) {
  return worktrees.some(
    (item) => item.branch === branch && item.directory !== current && item.directory !== target,
  )
}

// Result of a handoff move: where the conversation now lives. `created` is
// set when a fresh destination session was started (and the source archived)
// rather than the source session itself being moved.
export type HandoffMove = {
  directory: string
  sessionID: string
  created?: boolean
}

export type HandoffMoveClients = {
  handoffEndpoint: (input: { from: string; to: string }) => Promise<unknown>
  createSession: (input: { directory: string }) => Promise<{ id: string }>
  archiveSession: (input: { sessionID: string; directory: string }) => Promise<unknown>
}

// Moves the conversation to another worktree. The endpoint copies dirty files
// and, when leaving a non-primary worktree, rebinds that worktree's sessions to
// the destination, so the source session itself moves and is opened there.
// Leaving the primary checkout never rebinds: a destination session is started
// instead and the source is archived. A missing source session still allows
// the move with a fresh session — the caller surfaces that via toast.
export async function carryHandoffContext(input: {
  clients: HandoffMoveClients
  from: string
  to: string
  fromPrimary: boolean
  sourceSessionID?: string
}): Promise<HandoffMove> {
  await input.clients.handoffEndpoint({ from: input.from, to: input.to })
  if (input.sourceSessionID && !input.fromPrimary) {
    return { directory: input.to, sessionID: input.sourceSessionID }
  }
  const created = await input.clients.createSession({ directory: input.to })
  if (input.sourceSessionID) {
    await input.clients.archiveSession({ sessionID: input.sourceSessionID, directory: input.from })
  }
  return { directory: input.to, sessionID: created.id, created: true }
}

// First prompt text of a session: the oldest user message's own text parts.
// Binds the destination handoff session to the same opening prompt.
export function firstPromptText(input: {
  messages: readonly {
    id: string
    role: string
    parts: readonly { type: string; text?: string; synthetic?: boolean }[]
  }[]
}): string {
  const oldest = input.messages
    .filter((message) => message.role === "user")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  if (!oldest) return ""
  return oldest.parts
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => part.text ?? "")
    .join("")
    .trim()
}

export type HandoffPromptOutcome = "carry" | "empty-loaded" | "empty-unresolved"

// Decides how the handoff treats the source prompt. A real prompt carries
// over; an empty one is only silent when messages have actually loaded (the
// session has no prompt). When the session is missing or its messages have
// not loaded yet, the move proceeds empty but the caller must surface the
// moved-without-session toast so nothing is lost silently.
export function handoffPromptOutcome(input: { sessionFound: boolean; messagesLoaded: boolean; prompt: string }): HandoffPromptOutcome {
  if (input.prompt) return "carry"
  if (input.sessionFound && input.messagesLoaded) return "empty-loaded"
  return "empty-unresolved"
}

// Extracts the endpoint's own message from a WorktreeError-shaped rejection
// ({ name, data: { message } }) so the UI can surface the real failure reason.
export function handoffErrorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const row = error as Record<string, unknown>
  const data = typeof row.data === "object" && row.data !== null ? (row.data as Record<string, unknown>) : undefined
  const message = data?.message
  return typeof message === "string" && message.trim() ? message.trim() : undefined
}
