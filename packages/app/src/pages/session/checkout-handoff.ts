export type CheckoutRef = {
  directory: string
  branch?: string
}

export type HandoffDecision =
  | { ok: true; directory: string; create: boolean }
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
  const owned = input.worktrees.find((item) => item.directory !== input.primary)
  const target = onPrimary ? owned?.directory : input.primary
  if (input.branch && occupied(input.branch, input.current, target, input.worktrees)) {
    return { ok: false, reason: "occupied" }
  }
  if (!onPrimary) return { ok: true, directory: input.primary, create: false }
  if (owned) return { ok: true, directory: owned.directory, create: false }
  return { ok: true, directory: input.primary, create: true }
}

function occupied(branch: string, current: string, target: string | undefined, worktrees: readonly CheckoutRef[]) {
  return worktrees.some(
    (item) => item.branch === branch && item.directory !== current && item.directory !== target,
  )
}

// Result of a handoff move: where the conversation now lives, and whether the
// source session was marked moved (archived) or was missing and left alone.
export type HandoffMove = {
  directory: string
  sessionID: string
  movedSessionID?: string
}

export type HandoffMoveClients = {
  handoffEndpoint: (input: { from: string; to: string }) => Promise<unknown>
  createSession: (input: { directory: string }) => Promise<{ id: string }>
  archiveSession: (input: { sessionID: string; directory: string }) => Promise<unknown>
}

// Moves the conversation to another worktree: rebinds via the handoff
// endpoint, starts a destination session bound to the same first prompt, and
// archives the source session when one exists. A missing source session still
// allows the move with a fresh session — the caller surfaces that via toast.
export async function carryHandoffContext(input: {
  clients: HandoffMoveClients
  from: string
  to: string
  sourceSessionID?: string
}): Promise<HandoffMove> {
  await input.clients.handoffEndpoint({ from: input.from, to: input.to })
  const created = await input.clients.createSession({ directory: input.to })
  if (input.sourceSessionID) {
    await input.clients.archiveSession({ sessionID: input.sourceSessionID, directory: input.from })
    return { directory: input.to, sessionID: created.id, movedSessionID: input.sourceSessionID }
  }
  return { directory: input.to, sessionID: created.id }
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
