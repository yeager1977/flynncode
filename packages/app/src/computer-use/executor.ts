import { ComputerUseV1 } from "@opencode-ai/schema/computer-use-v1"
import { Option, Schema } from "effect"

export type ComputerUseAction = ComputerUseV1.Action
export type ComputerUseResult = ComputerUseV1.Result
export type ComputerUseRequest = ComputerUseV1.Request

// The window-side pane surface the desktop renderer owns. Both are optional at
// the platform boundary; the executor reports what it could not do instead of
// pretending the action happened.
export type ComputerUseSurface = {
  readonly computerUse: {
    readonly click: (appID: string, x: number, y: number) => Promise<void>
    readonly typeText: (appID: string, text: string) => Promise<void>
    readonly keypress: (appID: string, key: string) => Promise<void>
    readonly scroll: (appID: string, deltaX: number, deltaY: number) => Promise<void>
  }
  readonly previewHost: {
    readonly capture: () => Promise<string | undefined>
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

const dataUrl = (value: unknown): boolean => typeof value === "string" && value.startsWith("data:")

function perform(
  request: ComputerUseV1.Request,
  surface: ComputerUseSurface | undefined,
): Promise<ComputerUseV1.Result> {
  if (!surface) return Promise.resolve({ ok: false, error: "no desktop pane surface is available" })
  switch (request.action) {
    case "screenshot":
      return surface.previewHost.capture().then(
        (captured): ComputerUseV1.Result =>
          dataUrl(captured)
            ? { ok: true, screenshot: captured }
            : { ok: false, error: "no preview pane attached to capture" },
        (): ComputerUseV1.Result => ({ ok: false, error: "no preview pane attached to capture" }),
      )
    case "click": {
      const x = request.args?.x
      const y = request.args?.y
      if (typeof x !== "number" || typeof y !== "number")
        return Promise.resolve({ ok: false, error: "click requires x and y arguments" })
      return surface.computerUse
        .click(request.appID, x, y)
        .then((): ComputerUseV1.Result => ({ ok: true, output: `click sent to ${request.appID}` }))
        .catch((cause): ComputerUseV1.Result => ({ ok: false, error: message(cause) }))
    }
    case "type": {
      const text = request.args?.text ?? ""
      if (!text) return Promise.resolve({ ok: false, error: "type requires a text argument" })
      return surface.computerUse
        .typeText(request.appID, text)
        .then((): ComputerUseV1.Result => ({ ok: true, output: `type sent to ${request.appID}` }))
        .catch((cause): ComputerUseV1.Result => ({ ok: false, error: message(cause) }))
    }
    case "keypress": {
      const key = request.args?.key ?? ""
      if (!key) return Promise.resolve({ ok: false, error: "keypress requires a key argument" })
      return surface.computerUse
        .keypress(request.appID, key)
        .then((): ComputerUseV1.Result => ({ ok: true, output: `keypress sent to ${request.appID}` }))
        .catch((cause): ComputerUseV1.Result => ({ ok: false, error: message(cause) }))
    }
    case "scroll": {
      const deltaX = request.args?.deltaX
      const deltaY = request.args?.deltaY
      if (typeof deltaX !== "number" || typeof deltaY !== "number")
        return Promise.resolve({ ok: false, error: "scroll requires deltaX and deltaY arguments" })
      return surface.computerUse
        .scroll(request.appID, deltaX, deltaY)
        .then((): ComputerUseV1.Result => ({ ok: true, output: `scroll sent to ${request.appID}` }))
        .catch((cause): ComputerUseV1.Result => ({ ok: false, error: message(cause) }))
    }
  }
}

export function createComputerUseExecutor(input: ComputerUseExecutorInput) {
  return {
    /**
     * Decodes one published event, executes the pane action it can, and POSTs
     * the reply to the executor bridge. Events that are not computer-use
     * requests are ignored; a failed reply POST is left to the bridge's
     * timeout (the action stays "not performed").
     */
    async handle(event: unknown, directory?: string) {
      const request = decodeRequested(event)
      if (Option.isNone(request)) return
      const result = await perform(request.value.data, input.surface)
      await input.postReply({
        requestID: request.value.data.requestID,
        ...(directory ? { directory } : {}),
        result,
      }).catch(() => {
        console.warn("[computer-use] reply failed for " + request.value.data.requestID)
      })
    },
  }
}

export * as ComputerUseExecutor from "./executor"