import { ComputerUseV1 } from "@flynncode/schema/computer-use-v1"
import { Option, Schema } from "effect"

export type ComputerUseAction = ComputerUseV1.Action
export type ComputerUseResult = ComputerUseV1.Result
export type ComputerUseRequest = ComputerUseV1.Request

// The desktop main process answers every pane call with an explicit outcome.
// "unavailable" means this window cannot serve the request (it lost the
// exactly-once claim or has no preview pane); the executor then stays silent
// so a window that can serve the request still wins it.
export type ComputerUseActuation =
  | { readonly status: "performed" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "unavailable" }

export type ComputerUseScreenshot =
  | { readonly status: "performed"; readonly screenshot: string }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "unavailable" }

// The window-side pane surface the desktop renderer owns. It is optional at
// the platform boundary; the executor reports what it could not do instead of
// pretending the action happened.
export type ComputerUseSurface = {
  readonly computerUse: {
    readonly screenshot: (requestID: string, appID: string) => Promise<ComputerUseScreenshot>
    readonly click: (appID: string, x: number, y: number, requestID: string) => Promise<ComputerUseActuation>
    readonly typeText: (appID: string, text: string, requestID: string) => Promise<ComputerUseActuation>
    readonly keypress: (appID: string, key: string, requestID: string) => Promise<ComputerUseActuation>
    readonly scroll: (
      appID: string,
      deltaX: number,
      deltaY: number,
      requestID: string,
    ) => Promise<ComputerUseActuation>
  }
}

export type ComputerUseExecutorInput = {
  readonly surface: ComputerUseSurface | undefined
  readonly postReply: (payload: {
    readonly requestID: string
    readonly directory?: string
    readonly result: ComputerUseV1.Result
  }) => Promise<void>
}

const decodeRequested = Schema.decodeUnknownOption(ComputerUseV1.Event.Requested)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type ComputerUseOutcome = ComputerUseActuation | ComputerUseScreenshot

// IPC-level rejections (dead preload handle, torn-down main) are refusals to
// report; anything that resolves reaches the desktop's explicit outcome.
const actuation = (outcome: Promise<ComputerUseOutcome>): Promise<ComputerUseOutcome> =>
  outcome.catch((error): ComputerUseOutcome => ({ status: "refused", reason: message(error) }))

const toResult = (outcome: ComputerUseOutcome, output?: string): ComputerUseV1.Result | undefined => {
  if (outcome.status === "refused") return { ok: false, error: outcome.reason }
  if (outcome.status !== "performed") return undefined
  return "screenshot" in outcome
    ? { ok: true, screenshot: outcome.screenshot }
    : { ok: true, output: output ?? "" }
}

// undefined means "this window cannot serve the request", so no reply is posted.
async function perform(
  request: ComputerUseV1.Request,
  surface: ComputerUseSurface | undefined,
): Promise<ComputerUseV1.Result | undefined> {
  if (!surface) return { ok: false, error: "no desktop pane surface is available" }
  switch (request.action) {
    case "screenshot":
      return toResult(await actuation(surface.computerUse.screenshot(request.requestID, request.appID)))
    case "click": {
      const x = request.args?.x
      const y = request.args?.y
      if (typeof x !== "number" || typeof y !== "number")
        return { ok: false, error: "click requires x and y arguments" }
      return toResult(
        await actuation(surface.computerUse.click(request.appID, x, y, request.requestID)),
        `click sent to ${request.appID}`,
      )
    }
    case "type": {
      const text = request.args?.text ?? ""
      if (!text) return { ok: false, error: "type requires a text argument" }
      return toResult(
        await actuation(surface.computerUse.typeText(request.appID, text, request.requestID)),
        `type sent to ${request.appID}`,
      )
    }
    case "keypress": {
      const key = request.args?.key ?? ""
      if (!key) return { ok: false, error: "keypress requires a key argument" }
      return toResult(
        await actuation(surface.computerUse.keypress(request.appID, key, request.requestID)),
        `keypress sent to ${request.appID}`,
      )
    }
    case "scroll": {
      const deltaX = request.args?.deltaX
      const deltaY = request.args?.deltaY
      if (typeof deltaX !== "number" || typeof deltaY !== "number")
        return { ok: false, error: "scroll requires deltaX and deltaY arguments" }
      return toResult(
        await actuation(surface.computerUse.scroll(request.appID, deltaX, deltaY, request.requestID)),
        `scroll sent to ${request.appID}`,
      )
    }
  }
}

export interface ComputerUseExecutorHandle {
  handle(event: unknown, directory?: string): Promise<void>
}

export function createComputerUseExecutor(input: ComputerUseExecutorInput) {
  // When the reply itself is lost after acting, one honest "unconfirmed"
  // receipt is retried so the bridge never rewrites a performed action into
  // "not performed"; the second attempt is terminal (logged only).
  const deliver = async (
    requestID: string,
    directory: string | undefined,
    result: ComputerUseV1.Result,
    receipt: boolean,
  ) => {
    await input
      .postReply({ requestID, ...(directory ? { directory } : {}), result })
      .catch(() => {
        if (receipt) {
          console.warn("[computer-use] receipt delivery failed for " + requestID)
          return
        }
        return deliver(
          requestID,
          directory,
          {
            ok: false,
            error: "reply delivery failed after performing the action; the outcome is unconfirmed",
            unconfirmed: true,
          },
          true,
        )
      })
  }

  return {
    /**
     * Decodes one published event, executes the pane action it can, and POSTs
     * the reply to the executor bridge. Events that are not computer-use
     * requests are ignored. Exactly-one actuation is arbitrated by the desktop
     * main's request claim: windows that lose it never actuate and never reply.
     */
    async handle(event: unknown, directory?: string) {
      const request = decodeRequested(event)
      if (Option.isNone(request)) return
      const result = await perform(request.value.data, input.surface)
      if (!result) return
      await deliver(request.value.data.requestID, directory, result, false)
    },
  } satisfies ComputerUseExecutorHandle
}

export * as ComputerUseExecutor from "./executor"