import { Effect, Schema } from "effect"

export const ComputerUsePolicy = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.succeed(false as const))),
  allowedApps: Schema.optional(Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed([] as string[])),
  ),
}).annotate({ identifier: "ComputerUsePolicy" })
export type ComputerUsePolicy = Schema.Schema.Type<typeof ComputerUsePolicy>

export function resolveComputerUse(raw: unknown): { enabled: boolean; allowedApps: string[] } {
  const record = (raw ?? {}) as Record<string, unknown>
  const decoded = Schema.decodeUnknownSync(ComputerUsePolicy)({
    enabled: record.enabled,
    allowedApps: record.allowedApps,
  })
  return { enabled: decoded.enabled ?? false, allowedApps: [...(decoded.allowedApps ?? [])] }
}

export function isAppAllowed(appID: string, allowedApps: string[]): boolean {
  return allowedApps.includes(appID)
}

export * as ComputerUse from "./computer-use"
