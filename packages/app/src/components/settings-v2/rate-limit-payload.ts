import type { Config } from "@flynncode/sdk/v2/client"

// Mirror of the server defaults for an unset `rate_limit` block: stop on a
// usage limit, retry none of them (packages/flynncode/src/session/processor.ts)
// and fall back to no other model (packages/flynncode/src/session/prompt.ts).
export const RATE_LIMIT_DEFAULTS = { onLimit: "stop", retryUnder: 0, fallback: [] as string[] } as const

export type OnLimit = NonNullable<NonNullable<Config["rate_limit"]>["on_limit"]>

export function rateLimitFromConfig(config: Config | undefined) {
  const rateLimit = config?.rate_limit
  return {
    onLimit: rateLimit?.on_limit ?? RATE_LIMIT_DEFAULTS.onLimit,
    retryUnder: rateLimit?.retry_under ?? RATE_LIMIT_DEFAULTS.retryUnder,
    fallback: rateLimit?.fallback ?? RATE_LIMIT_DEFAULTS.fallback,
  }
}

// The server swaps config subtrees at write sites, so the patch always carries
// the full `rate_limit` block: changing one field never drops the others.
export function rateLimitToConfig(value: RateLimitValue): NonNullable<Config["rate_limit"]> {
  return { on_limit: value.onLimit, retry_under: value.retryUnder, fallback: [...value.fallback] }
}

export type RateLimitValue = ReturnType<typeof rateLimitFromConfig>

export function retryUnderFromInput(text: string) {
  // Whole seconds only; the server schema (NonNegativeInt) stays the authority.
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  return Number(trimmed)
}
