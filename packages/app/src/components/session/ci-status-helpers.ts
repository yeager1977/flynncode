export type CheckState = "SUCCESS" | "FAILURE" | "PENDING" | "SKIPPED" | "CANCELLED" | "ERROR"

export type Check = {
  name: string
  state: CheckState
  detail?: string
}

// Subset of the generated GhPrStatus the strip renders.
export type PrStatusPayload = {
  pr: {
    number: number
    state: string
    mergeable?: string
    url: string
    headRefName?: string
  }
  checks: Check[]
}

export const FAILED_STATES: ReadonlySet<CheckState> = new Set(["FAILURE", "ERROR", "CANCELLED"])
export const GH_DOCS_URL = "https://cli.github.com/"

// Summary line for the collapsed strip: worst state wins (failure > running
// > everything else), matching how developers glance at CI.
export const summaryKey = (checks: Check[]) => {
  if (checks.some((check) => FAILED_STATES.has(check.state))) return "session.ci.checks.failing"
  if (checks.some((check) => check.state === "PENDING")) return "session.ci.checks.pending"
  if (checks.length === 0) return "session.ci.checks.empty"
  return "session.ci.checks.passing"
}

export const checkDotClass = (state: CheckState) => {
  if (state === "SUCCESS") return "bg-[var(--icon-success-base)]"
  if (FAILED_STATES.has(state)) return "bg-[var(--icon-error-base)]"
  if (state === "PENDING") return "bg-[var(--icon-warning-base)]"
  return "bg-[var(--icon-base)]"
}

// The generated schema exposes number as a float-with-specials union; every
// real value flows through as a plain number here.
export const normalizePrStatus = (data: {
  pr: { number: number | string; state: string; mergeable?: string; url: string; headRefName?: string }
  checks: Check[]
}): PrStatusPayload => ({
  pr: {
    number: typeof data.pr.number === "number" ? data.pr.number : Number(data.pr.number),
    state: data.pr.state,
    ...(data.pr.mergeable ? { mergeable: data.pr.mergeable } : {}),
    url: data.pr.url,
    ...(data.pr.headRefName ? { headRefName: data.pr.headRefName } : {}),
  },
  checks: data.checks,
})

export type PrError = { name?: string; data?: { message?: string } }

export const prLoadError = (error: unknown) => {
  const body = (error as { body?: PrError })?.body ?? (error as PrError)
  const name = body?.name
  // A branch with no PR is a normal state, not an error storm.
  if (name === "GhNoPrError") return { kind: "hidden" } as const
  return {
    kind: "error",
    name: name ?? "UnknownError",
    message: body?.data?.message ?? (error instanceof Error ? error.message : String(error)),
  } as const
}

export type LoadState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error"; name: string; message: string }
  | { kind: "ready"; data: PrStatusPayload }