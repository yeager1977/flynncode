import type { Config } from "@flynncode/sdk/v2/client"

// Mirror of the server defaults for an unset `rate_limit` block: stop on a
// usage limit and retry none of them (packages/flynncode/src/session/processor.ts).
export const RATE_LIMIT_DEFAULTS = { onLimit: "stop", retryUnder: 0 } as const

export type OnLimit = NonNullable<NonNullable<Config["rate_limit"]>["on_limit"]>

export function rateLimitFromConfig(config: Config | undefined) {
  const rateLimit = config?.rate_limit
  return {
    onLimit: rateLimit?.on_limit ?? RATE_LIMIT_DEFAULTS.onLimit,
    retryUnder: rateLimit?.retry_under ?? RATE_LIMIT_DEFAULTS.retryUnder,
  }
}

// The server swaps config subtrees at write sites, so the patch always carries
// the full `rate_limit` block: changing one field never drops the other.
export function rateLimitToConfig(value: { onLimit: OnLimit; retryUnder: number }): NonNullable<Config["rate_limit"]> {
  return { on_limit: value.onLimit, retry_under: value.retryUnder }
}

export function retryUnderFromInput(text: string) {
  // Whole seconds only; the server schema (NonNegativeInt) stays the authority.
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  return Number(trimmed)
}
