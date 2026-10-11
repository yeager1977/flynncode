import { Effect, Option, Schema } from "effect"

export const ComputerUseTier = Schema.Literals(["observe", "mutate"]).annotate({
  identifier: "ComputerUseTier",
})
export type ComputerUseTier = typeof ComputerUseTier.Type

export const ComputerUseTiers = Schema.Struct({
  observe: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
  mutate: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
}).annotate({ identifier: "ComputerUseTiers" })
export type ComputerUseTiers = Schema.Schema.Type<typeof ComputerUseTiers>

export const ComputerUsePolicy = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.succeed(false as const))),
  allowedApps: Schema.optional(Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed([] as string[])),
  ),
  tiers: Schema.optional(ComputerUseTiers),
}).annotate({ identifier: "ComputerUsePolicy" })
export type ComputerUsePolicy = Schema.Schema.Type<typeof ComputerUsePolicy>

// The only real pane surface in this tier is the in-app browser pane; the app
// id is reserved and exact-match, so user-supplied ids cannot target it.
export const ReservedPaneAppID = "flynncode:browser-pane"

export interface ResolvedComputerUse {
  readonly enabled: boolean
  readonly allowedApps: string[]
  readonly tiers: {
    readonly observe: boolean
    readonly mutate: boolean
  }
}

// A tier is enabled unless the config explicitly disables it; tier values that
// do not decode (or are not objects) fail closed. Unknown tier keys are
// tolerated and gate nothing, so extra entries cannot break resolution.
const tierEnabled = (raw: unknown, tier: "observe" | "mutate"): boolean => {
  if (!raw || typeof raw !== "object") return true
  const value = (raw as Record<string, unknown>)[tier]
  if (value === undefined) return true
  if (typeof value !== "object") return false
  const enabled = (value as Record<string, unknown>).enabled
  if (enabled === undefined) return true
  if (typeof enabled !== "boolean") return false
  return enabled
}

export function resolveComputerUse(raw: unknown): ResolvedComputerUse {
  const record = (raw ?? {}) as Record<string, unknown>
  // The tier struct is validated separately so malformed values disable that
  // tier via the fail-closed helper below instead of failing the whole policy
  // resolution (unknown tier keys are tolerated and gate nothing).
  const tierInput =
    record.tiers === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(ComputerUseTiers)(record.tiers))
  const decoded = Schema.decodeUnknownSync(ComputerUsePolicy)({
    enabled: record.enabled,
    allowedApps: record.allowedApps,
    ...(tierInput ? { tiers: tierInput } : {}),
  })
  return {
    enabled: decoded.enabled ?? false,
    allowedApps: [...(decoded.allowedApps ?? [])],
    tiers: {
      observe: tierEnabled(record.tiers, "observe"),
      mutate: tierEnabled(record.tiers, "mutate"),
    },
  }
}

export function isAppAllowed(appID: string, allowedApps: string[]): boolean {
  return allowedApps.includes(appID)
}

export function actionTier(action: string): ComputerUseTier {
  return action === "screenshot" ? "observe" : "mutate"
}

export function isTierAllowed(action: string, tiers: ResolvedComputerUse["tiers"]): boolean {
  const tier = actionTier(action)
  return tier === "observe" ? tiers.observe : tiers.mutate
}

export * as ComputerUse from "./computer-use"