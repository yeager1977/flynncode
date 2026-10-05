import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"

const PR_FIELDS = "number,state,mergeable,statusCheckRollup,url,headRefName" as const

export class MissingError extends Schema.TaggedErrorClass<MissingError>()("GhMissingError", {
  message: Schema.String,
}) {}
export class AuthError extends Schema.TaggedErrorClass<AuthError>()("GhAuthError", { message: Schema.String }) {}
export class NoPrError extends Schema.TaggedErrorClass<NoPrError>()("GhNoPrError", { message: Schema.String }) {}
export class CommandError extends Schema.TaggedErrorClass<CommandError>()("GhCommandError", {
  message: Schema.String,
}) {}

export type Error = MissingError | AuthError | NoPrError | CommandError

export const CheckState = Schema.Literals(["SUCCESS", "FAILURE", "PENDING", "SKIPPED", "CANCELLED", "ERROR"])
export type CheckStateType = Schema.Schema.Type<typeof CheckState>

export const Check = Schema.Struct({
  name: Schema.String,
  state: CheckState,
  detail: Schema.optional(Schema.String),
}).annotate({ identifier: "GhCheck" })

export const PrInfo = Schema.Struct({
  number: Schema.Number,
  state: Schema.String,
  mergeable: Schema.optional(Schema.String),
  url: Schema.String,
  headRefName: Schema.optional(Schema.String),
}).annotate({ identifier: "GhPrInfo" })

export const PrStatus = Schema.Struct({
  pr: PrInfo,
  checks: Schema.Array(Check),
}).annotate({ identifier: "GhPrStatus" })
export type PrStatusType = Schema.Schema.Type<typeof PrStatus>

interface Interface {
  /** `gh --version` succeeds — the CLI is installed on PATH. */
  readonly installed: () => Effect.Effect<boolean>
  /** `gh auth status` exits zero — the CLI is installed and authenticated. */
  readonly authenticated: (directory?: string) => Effect.Effect<boolean, Error>
  /** PR + CI-check snapshot for the current branch of `directory`. Fails with
   *  `GhNoPrError` when the branch has no PR. */
  readonly prStatus: (directory: string) => Effect.Effect<PrStatusType, Error>
  /** Schedule a squash auto-merge for the current branch's PR. */
  readonly merge: (directory: string) => Effect.Effect<{ readonly merged: boolean }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Gh") {}

type RollupEntry = {
  __typename?: string
  name?: string
  title?: string
  state?: string
  status?: string
  conclusion?: string | null
  message?: string
}

type PrViewOutput = {
  number?: number
  state?: string
  mergeable?: string
  url?: string
  headRefName?: string
  statusCheckRollup?: RollupEntry[]
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service

    // Spawn failure (gh not on PATH) surfaces as AppProcessError; map it into
    // the Gh error union so every method shares one error channel.
    const run = Effect.fnUntraced(function* (args: string[], cwd?: string) {
      return yield* appProcess
        .run(
          ChildProcess.make("gh", args, {
            cwd,
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        )
        .pipe(
          Effect.mapError(
            (error) => new CommandError({ message: error instanceof Error ? error.message : String(error) }),
          ),
        )
    })

    const classify = (stderr: string): Error => {
      const message = stderr.trim()
      if (/gh:? (command )?not found|ENOENT|spawn/i.test(message)) return new MissingError({ message })
      if (/not logged into|authentication|gh auth/i.test(message)) return new AuthError({ message })
      if (/no pull requests?|no open pull/i.test(message)) return new NoPrError({ message })
      return new CommandError({ message })
    }

    const rolloutState = (check: RollupEntry): CheckStateType => {
      // GitHub's rollup mixes CheckRun (status/conclusion) and StatusContext
      // (state) entries; normalize both to one state vocabulary.
      if (check.__typename === "CheckRun") {
        const status = check.status?.toUpperCase()
        if (status && status !== "COMPLETED") return "PENDING"
        const conclusion = check.conclusion?.toUpperCase()
        if (conclusion === "SUCCESS") return "SUCCESS"
        if (conclusion === "FAILURE") return "FAILURE"
        if (conclusion === "SKIPPED") return "SKIPPED"
        if (conclusion === "CANCELLED") return "CANCELLED"
        return "ERROR"
      }
      const state = check.state?.toUpperCase()
      if (state === "SUCCESS") return "SUCCESS"
      if (state === "FAILURE") return "FAILURE"
      if (state === "SKIPPED") return "SKIPPED"
      if (state === "CANCELLED") return "CANCELLED"
      if (state === "ERROR") return "ERROR"
      return "PENDING"
    }

    const toPrStatus = (parsed: PrViewOutput): PrStatusType => {
      const checks = (parsed.statusCheckRollup ?? []).map((check) => {
        const state = rolloutState(check)
        return Check.make({
          name: check.name ?? check.title ?? "check",
          state,
          ...(state === "FAILURE" && check.message ? { detail: check.message } : {}),
        })
      })
      return PrStatus.make({
        pr: PrInfo.make({
          number: parsed.number ?? 0,
          state: parsed.state ?? "UNKNOWN",
          ...(parsed.mergeable ? { mergeable: parsed.mergeable } : {}),
          url: parsed.url ?? "",
          ...(parsed.headRefName ? { headRefName: parsed.headRefName } : {}),
        }),
        checks,
      })
    }

    const installed = Effect.fn("Gh.installed")(function* () {
      return yield* run(["--version"]).pipe(
        Effect.map((result) => result.exitCode === 0),
        Effect.catch(() => Effect.succeed(false)),
      )
    })

    const authenticated = Effect.fn("Gh.authenticated")(function* (directory?: string) {
      const result = yield* run(["auth", "status"], directory)
      if (result.exitCode === 0) return true
      return yield* Effect.fail(classify(result.stderr.toString()))
    })

    const prStatus = Effect.fn("Gh.prStatus")(function* (directory: string) {
      const result = yield* run(["pr", "view", "--json", PR_FIELDS], directory)
      if (result.exitCode !== 0) return yield* Effect.fail(classify(result.stderr.toString()))
      return toPrStatus(JSON.parse(result.stdout.toString("utf8")) as PrViewOutput)
    })

    const merge = Effect.fn("Gh.merge")(function* (directory: string) {
      const result = yield* run(["pr", "merge", "--squash", "--auto"], directory)
      if (result.exitCode !== 0) return yield* Effect.fail(classify(result.stderr.toString()))
      return { merged: true }
    })

    return Service.of({ installed, authenticated, prStatus, merge })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [AppProcess.node] })

export * as Gh from "./gh"