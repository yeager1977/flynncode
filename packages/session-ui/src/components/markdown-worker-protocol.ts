import type { Block, Projection } from "./markdown-stream"

export type MarkdownToken = [content: string, style: string]

export type MarkdownWorkerRequest =
  | { type: "parse"; id: number; text: string }
  // `text` continues the worker's copy at `offset`; offset 0 replaces it.
  | { type: "project"; id: number; key: string; offset: number; text: string; live: boolean }
  | { type: "highlight"; id: number; key: string; text: string; language: string; complete?: boolean }
  | { type: "dispose"; key: string }

export type MarkdownWorkerResponse =
  | { type: "parse"; id: number; html: string }
  | { type: "project"; id: number; key: string; firstChangedBlock: number; blocks: Block[] }
  | {
      type: "highlight"
      id: number
      key: string
      language: string
      reset: boolean
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }
  | { type: "error"; id: number; key?: string; message: string }
  | { type: "superseded"; id: number; key: string }

export type MarkdownWorkerState = {
  id: number
  generation: number
  language: string
  stable: MarkdownToken[]
  unstable: MarkdownToken[]
}

export function shouldReleaseMarkdownWorkerState(complete: boolean, latestID: number | undefined, responseID: number) {
  return complete && latestID === responseID
}

export function markdownBlockKey(owner: string, cacheKey: string | undefined, index: number, mode: string) {
  return `${owner}:${cacheKey ? `${cacheKey}:${index}:${mode}` : `block:${index}`}`
}

export function applyMarkdownWorkerResponse(
  state: MarkdownWorkerState | undefined,
  response: Extract<MarkdownWorkerResponse, { type: "highlight" }>,
) {
  if (state && response.id <= state.id) return state
  return {
    id: response.id,
    generation: (state?.generation ?? 0) + (response.reset ? 1 : 0),
    language: response.language,
    stable: response.reset ? response.stable : [...(state?.stable ?? []), ...response.stable],
    unstable: response.unstable,
  }
}

export function appendedText(sent: string | undefined, text: string) {
  if (sent === undefined || !text.startsWith(sent)) return { offset: 0, text }
  return { offset: sent.length, text: text.slice(sent.length) }
}

export function continueText(previous: string | undefined, offset: number, text: string) {
  if (offset === 0) return text
  if (previous?.length !== offset) return
  return previous + text
}

export function firstChangedBlock(previous: Projection | undefined, next: Projection) {
  const blocks = previous?.blocks ?? []
  const index = next.blocks.findIndex((block, index) => !sameBlock(blocks[index], block))
  return index < 0 ? next.blocks.length : index
}

export function mergeProjection(previous: Projection | undefined, text: string, first: number, blocks: Block[]) {
  return { text, blocks: [...(previous?.blocks.slice(0, first) ?? []), ...blocks] } satisfies Projection
}

function sameBlock(left: Block | undefined, right: Block) {
  return (
    !!left &&
    left.mode === right.mode &&
    left.raw === right.raw &&
    left.src === right.src &&
    left.language === right.language &&
    left.complete === right.complete
  )
}
