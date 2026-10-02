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
